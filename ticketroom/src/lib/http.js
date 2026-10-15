// Outbound HTTP for external integrations (payments, SMS, TitoPay wallet).
// Every call is timed and logged to integration_calls with metadata only —
// never request or response bodies, which can carry personal data or secrets.
const db = require("./db");
const { AppError } = require("./errors");

async function logCall(row) {
  try {
    await db.query(
      "INSERT INTO integration_calls (integration, environment, operation, http_status, ok, duration_ms, error) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [row.integration, row.environment, row.operation, row.status || null, row.ok, row.ms, row.error ? String(row.error).slice(0, 300) : null]);
  } catch { /* logging must never break a payment */ }
}

// Returns { status, ok, body, text }. Throws AppError(502) on network failure
// or timeout so callers can treat the outcome as UNKNOWN, not as failed.
async function call({ integration, environment, operation, url, method = "GET", headers = {}, json, form, body, timeoutMs = 15000 }) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const h = { accept: "application/json", ...headers };
  let payload = body;
  if (json !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(json); }
  if (form !== undefined) { h["content-type"] = "application/x-www-form-urlencoded"; payload = form; }
  try {
    const res = await fetch(url, { method, headers: h, body: payload, signal: ctl.signal });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    await logCall({ integration, environment, operation, status: res.status, ok: res.ok, ms: Date.now() - started, error: res.ok ? null : (parsed?.message || parsed?.error?.message || parsed?.detail || text.slice(0, 120)) });
    return { status: res.status, ok: res.ok, body: parsed, text };
  } catch (err) {
    const timeout = err.name === "AbortError";
    await logCall({ integration, environment, operation, ok: false, ms: Date.now() - started, error: timeout ? "timeout" : err.message });
    throw new AppError(502, timeout ? "integration_timeout" : "integration_unreachable", `${integration}: ${timeout ? "timed out" : "unreachable"}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { call };
