"use strict";

// THE CANONICAL BANKING STATE. TITOPAY'S WORDS, NOT A BANK'S.
//
// Every bank has its own vocabulary for the same eleven things, and every one
// of those vocabularies is temporary. This file is the one TitoPay keeps. An
// adapter's job is to translate into it; nothing above the adapter ever sees a
// provider's own word for a state.
//
// WHAT THIS IS NOT: it is not `transactions.status`, and it does not replace
// it. `transactions.status` is core infrastructure, read across the platform
// and protected by database triggers that refuse to move a transaction out of
// `reversed`. That column keeps its meaning and its lifecycle exactly. The
// canonical state lives BESIDE it, describing where a payment sits in a BANK'S
// lifecycle, and maps DOWN to the transaction status TitoPay already uses.
//
// THE RULE THAT MATTERS MOST: only SUCCESS may credit a wallet, and reaching
// SUCCESS is not this file's decision. A state is a description of evidence
// already gathered. The evidence itself comes from an independent status query
// to the provider, never from a callback body, never from a browser redirect,
// and never from a timeout expiring.
//
// IN_DOUBT IS NOT A FAILURE AND NOT A SUCCESS. It is the honest state for "the
// provider did not answer, or answered something we do not recognise". Money
// may or may not have moved. It never auto-resolves in either direction: it is
// resolved by asking the provider again, or by a human with the provider's
// statement in front of them. An unrecognised provider state maps HERE, which
// is why `toCanonicalState` defaults to IN_DOUBT rather than to FAILED. A wrong
// FAILED is a customer charged for nothing; a wrong SUCCESS is money credited
// that never arrived. IN_DOUBT is the only safe place to not know.

const STATES = {
  CREATED: "CREATED",
  CONSENT_PENDING: "CONSENT_PENDING",
  AUTHORISED: "AUTHORISED",
  PAYMENT_PENDING: "PAYMENT_PENDING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  IN_DOUBT: "IN_DOUBT",
  CANCELLED: "CANCELLED",
  REFUNDED: "REFUNDED"
};

const ALL_STATES = Object.freeze(Object.values(STATES));

// States from which nothing further happens on its own. REFUNDED is terminal
// too: a refund is its own transaction, not a rewind of this one.
const TERMINAL_STATES = Object.freeze([
  STATES.SUCCESS, STATES.FAILED, STATES.REJECTED,
  STATES.EXPIRED, STATES.CANCELLED, STATES.REFUNDED
]);

// The ONLY state that may result in a wallet credit. Deliberately a list of
// one, and deliberately its own export, so that a future state cannot join it
// by looking similar to it.
const CREDITING_STATES = Object.freeze([STATES.SUCCESS]);

// How a canonical state is expressed in the transaction lifecycle that already
// exists. Nothing here invents a transaction status: every value below is one
// the platform already writes today.
//
// IN_DOUBT maps to `processing`, which is exactly what the existing card
// top-up path already does with a provider result it cannot resolve. That is
// not a coincidence; it is the precedent this table follows.
const TRANSACTION_STATUS = Object.freeze({
  [STATES.CREATED]: "pending",
  [STATES.CONSENT_PENDING]: "pending",
  [STATES.AUTHORISED]: "pending",
  [STATES.PAYMENT_PENDING]: "pending",
  [STATES.SUCCESS]: "completed",
  [STATES.FAILED]: "failed",
  [STATES.REJECTED]: "failed",
  [STATES.EXPIRED]: "cancelled",
  [STATES.CANCELLED]: "cancelled",
  [STATES.IN_DOUBT]: "processing",
  [STATES.REFUNDED]: "refunded"
});

// Permitted moves. A payment goes forward, or it goes to IN_DOUBT, or it ends.
// Absent from every list: any edge INTO SUCCESS that does not come from
// evidence, and any edge OUT of a terminal state other than SUCCESS -> REFUNDED.
const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.CREATED]: [
    STATES.CONSENT_PENDING, STATES.AUTHORISED, STATES.PAYMENT_PENDING,
    STATES.FAILED, STATES.REJECTED, STATES.EXPIRED, STATES.CANCELLED, STATES.IN_DOUBT
  ],
  [STATES.CONSENT_PENDING]: [
    STATES.AUTHORISED, STATES.REJECTED, STATES.EXPIRED, STATES.CANCELLED,
    STATES.FAILED, STATES.IN_DOUBT
  ],
  [STATES.AUTHORISED]: [
    STATES.PAYMENT_PENDING, STATES.SUCCESS, STATES.FAILED,
    STATES.EXPIRED, STATES.CANCELLED, STATES.IN_DOUBT
  ],
  [STATES.PAYMENT_PENDING]: [
    STATES.SUCCESS, STATES.FAILED, STATES.EXPIRED, STATES.CANCELLED, STATES.IN_DOUBT
  ],
  // The one way out of not knowing, in either direction, and only from
  // evidence. This edge is why IN_DOUBT is safe to default to.
  [STATES.IN_DOUBT]: [
    STATES.SUCCESS, STATES.FAILED, STATES.REJECTED, STATES.EXPIRED, STATES.CANCELLED
  ],
  // A settled payment can only be refunded, and a refund is its own money
  // movement with its own transaction.
  [STATES.SUCCESS]: [STATES.REFUNDED],
  [STATES.FAILED]: [],
  [STATES.REJECTED]: [],
  [STATES.EXPIRED]: [],
  [STATES.CANCELLED]: [],
  [STATES.REFUNDED]: []
});

function isCanonicalState(value) {
  return ALL_STATES.includes(String(value || ""));
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(String(state || ""));
}

// Whether this state is allowed to move money into a wallet. Callers ask this
// rather than comparing against a string, so there is one place to read when
// somebody asks "what can credit?".
function creditsWallet(state) {
  return CREDITING_STATES.includes(String(state || ""));
}

function transactionStatusFor(state) {
  return TRANSACTION_STATUS[String(state || "")] || null;
}

function canTransition(from, to) {
  if (!isCanonicalState(from) || !isCanonicalState(to)) return false;
  if (from === to) return true; // a repeated report of the same state is a no-op, not an error
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

// Translate a provider's own word into TitoPay's.
//
// `mapping` belongs to the ADAPTER: it is the one place a bank's vocabulary is
// allowed to appear, and it is passed in rather than declared here so that this
// file never learns a provider's words.
//
// ANYTHING UNRECOGNISED BECOMES IN_DOUBT. Not FAILED, which would tell a
// customer their money is safe when it may have left; not SUCCESS, which would
// credit a wallet on a word nobody has checked. This mirrors the identity layer,
// where an unrecognised verification result becomes `review_required` rather
// than being guessed into a pass.
function toCanonicalState(providerState, mapping = {}) {
  const raw = String(providerState == null ? "" : providerState).trim();
  if (!raw) return STATES.IN_DOUBT;
  const mapped = mapping[raw] ?? mapping[raw.toLowerCase()] ?? mapping[raw.toUpperCase()];
  if (mapped && isCanonicalState(mapped)) return mapped;
  return STATES.IN_DOUBT;
}

module.exports = {
  STATES,
  ALL_STATES,
  TERMINAL_STATES,
  CREDITING_STATES,
  ALLOWED_TRANSITIONS,
  TRANSACTION_STATUS,
  isCanonicalState,
  isTerminal,
  creditsWallet,
  transactionStatusFor,
  canTransition,
  toCanonicalState
};
