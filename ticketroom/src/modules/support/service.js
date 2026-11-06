// Customer questions as conversations. Customer care answers them, or passes
// one to the organiser it belongs to; the organiser replies from their portal
// (the reply is emailed to the customer by TicketRoom) or hands it back.
// Every step is kept on the case, so nobody is left guessing.
const db = require("../../lib/db");
const { notFound } = require("../../lib/errors");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getCase(id, q = db) {
  if (!UUID.test(String(id))) throw notFound("Case not found.");
  const { rows: [c] } = await q.query(
    `SELECT s.*, o.name AS organiser_name, o.ref AS organiser_ref, e.title AS event_title FROM support_cases s
       LEFT JOIN organisers o ON o.id = s.organiser_id LEFT JOIN events e ON e.id = s.event_id WHERE s.id = $1`, [id]);
  if (!c) throw notFound("Case not found.");
  return c;
}

// customerView: only what was emailed to the customer.
async function messages(caseId, customerView = false, q = db) {
  const { rows } = await q.query(
    `SELECT m.id, m.author_kind, m.body, m.emailed, m.created_at, u.full_name AS author_name
       FROM support_messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.case_id = $1 ${customerView ? "AND m.emailed" : ""} ORDER BY m.id`, [caseId]);
  return rows;
}

function note(q, caseId, authorId, kind, body, emailed = false) {
  return q.query("INSERT INTO support_messages (case_id, author_id, author_kind, body, emailed) VALUES ($1,$2,$3,$4,$5)", [caseId, authorId, kind, body, emailed]);
}

// The customer's events, so customer care can pick the right organiser in one click.
async function suggestions(c, q = db) {
  const { rows } = await q.query(
    `SELECT DISTINCT e.organiser_id, org.name AS organiser_name, org.ref AS organiser_ref, e.id AS event_id, e.title AS event_title, e.starts_at
       FROM orders o JOIN events e ON e.id = o.event_id JOIN organisers org ON org.id = e.organiser_id
      WHERE (o.user_id = $1 OR lower(o.buyer_email) = lower($2)) AND o.status IN ('paid','partially_refunded','refunded','paid_unfulfilled')
      ORDER BY e.starts_at DESC LIMIT 10`, [c.user_id || null, c.email]);
  return rows;
}

// A case as one organiser may see it: only when it was passed to them.
async function organiserCase(orgId, id) {
  const c = await getCase(id);
  if (c.organiser_id !== orgId) throw notFound("Query not found.");
  return c;
}

const firstName = (name) => String(name || "").trim().split(/\s+/)[0];

module.exports = { getCase, messages, note, suggestions, organiserCase, firstName };
