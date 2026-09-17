"use strict";

// CLEARING A DRAFT: ONE RULE, SIX SURFACES.
//
// A customer accumulates half-finished things - a stokvel group they named and
// never invited anybody to, a TitoPro listing they never published, an event
// they thought better of, a product typed in twice. Today none of them can be
// removed, so the screen fills with clutter the person cannot act on and
// cannot get rid of, and every list becomes harder to read than the one thing
// in it that matters.
//
// THE RULE, IN ONE SENTENCE:
//
//   You may clear something you own that has never been used - no money in or
//   out, nobody else involved, nothing depending on it. Anything else is
//   closed or archived instead, and is told why.
//
// WHY THIS IS NOT "ADD A DELETE BUTTON". TitoPay deletes nothing, on purpose
// and repeatedly: an account is closed rather than removed, a TitoPro listing
// taken down is kept on file, a fraudulent rating is withdrawn rather than
// erased. Every one of those rules exists because the record was the evidence
// for a decision somebody may be asked about later.
//
// A draft is the one case where that reasoning does not apply, and the
// difference is exactly the test below: a thing nobody has transacted against,
// nobody else has joined, and nothing else points at is not a record of
// anything. Removing it destroys no evidence because there is none.
//
// So this helper exists to make that distinction structural rather than a
// judgement call repeated in six places. Each caller states the blockers in
// its own vocabulary; this decides, and phrases the refusal the same way
// everywhere so a customer meets one idea rather than six.

const { AppError } = require("./errors");

// A blocker names the thing that makes this NOT a draft, in the customer's
// words. `count` is optional and only used to make the sentence read properly
// for one versus many.
//
//   { count: 3, one: "1 other member has joined", many: "3 other members have joined" }
//
// The wording is the caller's because only the caller knows what the thing is.
// A stokvel does not have "tickets sold" and an event does not have "members".
function blocker(count, one, many) {
  const total = Number(count) || 0;
  if (!total) return null;
  return total === 1 ? one : (many || one).replace("{count}", String(total));
}

// THE DECISION. Returns nothing when the thing may be cleared, and throws a
// 409 naming every reason when it may not.
//
// EVERY reason, not just the first: a customer told "this stokvel has members"
// who removes them and is then told "it has contributions" has been sent round
// a loop that could have been one sentence. The refusal lists what is true.
//
// `alternative` is what they can do instead, and it is required. A refusal
// that does not say what the person may do instead is a dead end, and for
// every one of these surfaces there IS something: close the group, archive the
// product, cancel the event.
function assertClearable(what, blockers, alternative) {
  const reasons = blockers.filter(Boolean);
  if (!reasons.length) return;
  const list = reasons.length === 1
    ? reasons[0]
    : `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
  throw new AppError(409,
    `This ${what} cannot be cleared because ${list}. ${alternative}`,
    { code: "not_a_draft", reasons });
}

// How many rows in `table` point at this thing. The one query every caller
// needs, written once so no caller has to remember that a COUNT comes back as
// a string from node-postgres and that "0" is truthy.
//
// The table and column names are interpolated because an identifier cannot be
// a bound parameter. They come from this repository's own schema and never
// from a request, and the guard below makes that structural rather than a
// promise: anything that is not a plain identifier is refused outright, so a
// caller cannot reach a request value into this position even by accident.
//
// EXTRA CONDITIONS TAKE BOUND PARAMETERS, NOT INTERPOLATION. `extraWhere` is
// SQL written by the caller and `extraParams` are its values, starting at $2.
// The first version of this took only the SQL, and the first caller wrote
// `AND user_id <> '${userId}'::uuid` into it - a value in a string, which is
// the whole shape of the mistake this signature now makes impossible.
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

async function countReferences(pool, table, column, id, extraWhere = "", extraParams = []) {
  for (const [name, value] of [["table", table], ["column", column]]) {
    if (!IDENTIFIER.test(String(value))) {
      throw new Error(`countReferences: ${name} "${value}" is not a plain identifier`);
    }
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} = $1 ${extraWhere}`,
    [id, ...extraParams]);
  return rows[0].count;
}

module.exports = { assertClearable, blocker, countReferences };
