// Gate passes: crew, artists, media, vendors and guests get a gate pass
// instead of a ticket. Each pass has a private link (only its hash is stored)
// and its own signed QR code; reissuing a pass makes a new link and QR code,
// so old copies stop working. Re-entry passes scan in every time.
const QRCode = require("qrcode");
const config = require("../../config");
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const { randomCode, randomToken, sha256 } = require("../../lib/crypto");
const { conflict, notFound } = require("../../lib/errors");
const outbox = require("../messaging/outbox");
const templates = require("../messaging/templates");
const qr = require("./qr");

const PASS_ROLES = { crew: "Crew", artist: "Artist / performer", media: "Media", vendor: "Vendor", security: "Security", medical: "Medical",
  sponsor: "Sponsor", guest: "Guest list", staff: "Event staff", all_access: "All access" };
const PASS_LIMIT = 5000;
// Passes work from two days before the event (build) to a day after (strike).
const PASS_BEFORE_H = 48;
const PASS_AFTER_H = 24;

const roleLabel = (role) => PASS_ROLES[role] || role;
// What the scanner shows under the name: "Gate pass · Crew · Stage door".
const passLabel = (g) => `Gate pass · ${roleLabel(g.role)}${g.access_note ? ` · ${g.access_note}` : ""}`;

const view = (g) => ({
  id: g.id, code: g.code, holderName: g.holder_name, email: g.email, role: g.role, roleLabel: roleLabel(g.role),
  accessNote: g.access_note, reentry: g.reentry, status: g.status, scans: g.scans,
  firstScannedAt: g.first_scanned_at, lastScannedAt: g.last_scanned_at, createdAt: g.created_at,
});

const svg = (g) => QRCode.toString(qr.passPayloadFor(g), { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#0B1A33", light: "#FFFFFF" } });
const linkFor = (token) => `${config.publicBaseUrl}/pass?t=${token}`;

// A code no ticket or pass uses yet.
async function newCode(c) {
  for (;;) {
    const code = randomCode(10);
    const { rows } = await c.query("SELECT 1 FROM tickets WHERE code = $1 UNION ALL SELECT 1 FROM gate_passes WHERE code = $1", [code]);
    if (!rows[0]) return code;
  }
}

async function send(c, g, event, url) {
  if (!g.email) return;
  const { rows: [org] } = await c.query("SELECT name FROM organisers WHERE id = $1", [event.organiser_id]);
  await outbox.enqueue(c, { to: g.email, ...templates.gatePass({ name: g.holder_name, organiser: org.name, role: roleLabel(g.role), event, url, reentry: g.reentry }) });
}

// Creates passes for a list of people in one go. Returns each pass with its
// link. The caller checks the organiser is approved when anyone gets an email.
async function issue(actor, event, people, { role, accessNote, reentry }) {
  return db.withTx(async (c) => {
    // Locking the event keeps two bulk requests from going over the limit together.
    await c.query("SELECT id FROM events WHERE id = $1 FOR UPDATE", [event.id]);
    const { rows: [{ n }] } = await c.query("SELECT count(*)::int AS n FROM gate_passes WHERE event_id = $1", [event.id]);
    if (n + people.length > PASS_LIMIT) throw conflict(`An event can have at most ${PASS_LIMIT} gate passes.`, "pass_limit");
    const out = [];
    for (const p of people) {
      const token = randomToken(24);
      const { rows: [g] } = await c.query(
        `INSERT INTO gate_passes (event_id, code, holder_name, email, role, access_note, reentry, link_token_hash, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [event.id, await newCode(c), p.holderName, p.email || null, role, accessNote || null, !!reentry, sha256(token), actor.id]);
      await send(c, g, event, linkFor(token));
      out.push({ pass: view(g), url: linkFor(token) });
    }
    await audit.record(c, { actor, action: "gate_pass.issued", entityType: "event", entityId: event.id, organiserId: event.organiser_id, details: { count: out.length, role } });
    return out;
  });
}

async function get(event, passId, q = db) {
  const { rows } = await q.query("SELECT * FROM gate_passes WHERE id = $1 AND event_id = $2", [passId, event.id]);
  if (!rows[0]) throw notFound("Pass not found.");
  return rows[0];
}

async function revoke(actor, event, passId) {
  const g = await get(event, passId);
  const { rows } = await db.query("UPDATE gate_passes SET status = 'revoked', updated_at = now() WHERE id = $1 RETURNING *", [g.id]);
  await audit.record(null, { actor, action: "gate_pass.revoked", entityType: "gate_pass", entityId: g.id, organiserId: event.organiser_id });
  return rows[0];
}

// New link and QR code (lost phone, link shared by mistake). Old copies stop working.
async function reissue(actor, event, passId) {
  return db.withTx(async (c) => {
    const token = randomToken(24);
    const { rows } = await c.query(
      "UPDATE gate_passes SET link_token_hash = $3, qr_version = qr_version + 1, updated_at = now() WHERE id = $1 AND event_id = $2 RETURNING *",
      [passId, event.id, sha256(token)]);
    const g = rows[0];
    await send(c, g, event, linkFor(token));
    await audit.record(c, { actor, action: "gate_pass.reissued", entityType: "gate_pass", entityId: g.id, organiserId: event.organiser_id });
    return { pass: view(g), url: linkFor(token) };
  });
}

// Runs inside admit()'s transaction. Re-entry passes are let in every time
// (each entry is logged); single-entry passes work once, like a ticket.
// `typed` is a pass already found from a typed code.
async function admit(c, staff, ev, { payload, gate, typed }) {
  const log = async (outcome, passId = null) => {
    await c.query("INSERT INTO admission_log (event_id, pass_id, scanned_by, outcome, gate) VALUES ($1,$2,$3,$4,$5)", [ev.id, passId, staff.id, outcome, gate || null]);
  };
  let g = typed;
  if (!g) {
    const p = qr.parsePass(payload);
    if (!p) { await log("invalid"); return { outcome: "invalid", message: "Not a TicketRoom pass, or the code has been altered." }; }
    g = (await c.query("SELECT * FROM gate_passes WHERE code = $1", [p.code])).rows[0];
    if (!g) { await log("invalid"); return { outcome: "invalid", message: "Pass not found." }; }
    if (p.version !== g.qr_version) { await log("invalid", g.id); return { outcome: "invalid", message: "This pass was replaced. Ask for the current pass." }; }
  }
  const label = passLabel(g);
  if (g.event_id !== ev.id) { await log("wrong_event", g.id); return { outcome: "wrong_event", message: "This pass is for a different event.", holderName: g.holder_name }; }
  if (g.status !== "active") { await log("revoked", g.id); return { outcome: "revoked", message: "This pass was cancelled by the organiser.", holderName: g.holder_name }; }
  const now = Date.now();
  if (now < new Date(ev.starts_at).getTime() - PASS_BEFORE_H * 3600e3 || now > new Date(ev.ends_at).getTime() + PASS_AFTER_H * 3600e3) {
    await log("event_not_live", g.id);
    return { outcome: "event_not_live", message: "Passes for this event are not valid right now." };
  }
  // For a single-entry pass, "scans = 0" is the atomic guard against double entry.
  const { rows } = await c.query(
    `UPDATE gate_passes SET scans = scans + 1, first_scanned_at = COALESCE(first_scanned_at, now()), last_scanned_at = now(), updated_at = now()
      WHERE id = $1 ${g.reentry ? "" : "AND scans = 0"} RETURNING id`, [g.id]);
  if (!rows[0]) {
    await log("already_used", g.id);
    return { outcome: "already_used", message: "Single-entry pass, already scanned.", admittedAt: g.first_scanned_at, holderName: g.holder_name, ticketType: label };
  }
  await log("admitted", g.id);
  return { outcome: "admitted", message: "Admit", holderName: g.holder_name, ticketType: label, code: g.code, pass: true, reentry: g.reentry };
}

module.exports = { PASS_ROLES, PASS_LIMIT, roleLabel, passLabel, view, svg, issue, get, revoke, reissue, admit };
