"use strict";

const { randomInt } = require("crypto");

function normalizeTicketPrefix(prefix = "TP") {
  const value = String(prefix || "TP").replace(/[^A-Z]/gi, "").toUpperCase().slice(0, 2);
  return value.length === 2 ? value : "TP";
}

function generateTicketRefCandidate(prefix = "TP") {
  return `${normalizeTicketPrefix(prefix)}${String(randomInt(0, 1000000)).padStart(6, "0")}`;
}

async function generateUniqueTicketRef(queryable, prefix = "TP", attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ticketRef = generateTicketRefCandidate(prefix);
    const { rows } = await queryable.query("SELECT 1 FROM support_tickets WHERE ticket_ref = $1 LIMIT 1", [ticketRef]);
    if (!rows[0]) return ticketRef;
  }
  throw new Error("Unable to allocate support ticket reference");
}

module.exports = {
  generateTicketRefCandidate,
  generateUniqueTicketRef
};
