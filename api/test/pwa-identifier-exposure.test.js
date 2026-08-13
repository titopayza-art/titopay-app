"use strict";

// WHOSE EYES IS IT ON THE SCREEN FOR?
//
// A customer saw their own @username printed on the My Workplaces empty
// state and asked whether TitoPay had made it public. It had not — that
// screen renders only inside their own signed-in session, and a @username is
// a payment handle rather than a credential. But the question was fair: the
// app had put an account identifier on screen where it did not need to be,
// in a panel people screenshot and send to someone else when asking for help.
//
// The rule this holds: an identifier the app wants to help you SHARE is
// copied, not displayed. The value may sit in a data-copy-value attribute,
// where a screenshot cannot carry it, and never in visible text.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

test("no screen prints the signed-in user's own identifiers as visible text", () => {
  // Every interpolation of the account's own identifiers, with the attribute
  // form (data-copy-value="...") removed first — that one is deliberate.
  const withoutCopyAttributes = APP.replace(/data-copy-value="[^"]*"/g, "");
  const offenders = [];
  withoutCopyAttributes.split("\n").forEach((line, index) => {
    if (/\$\{esc\(state\.user\.(username|email|phone)\)\}/.test(line)
      || /\$\{esc\(state\.user\?\.(username|email|phone)\)\}/.test(line)) {
      // The Profile screen is the account's own detail page — showing your
      // details there, each with its own copy button, is the point of it.
      if (/profileSummaryRow/.test(line)) return;
      offenders.push(`${index + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
  assert.deepEqual(offenders, [],
    "these lines print an account identifier as visible text:\n  " + offenders.join("\n  ") +
    "\nPut it in a data-copy-value button instead, so it is shared on purpose rather than displayed.");
});

test("My Workplaces offers the username to copy rather than showing it", () => {
  const start = APP.indexOf("No workplaces yet");
  assert.notEqual(start, -1, "the empty state should exist");
  const panel = APP.slice(start, start + 900);
  assert.match(panel, /data-copy-value="@\$\{esc\(state\.user\.username\)\}"/,
    "the handle is offered as a copy action");
  assert.doesNotMatch(panel, /<strong>@\$\{esc\(state\.user/,
    "the handle must not be printed into the panel's text");
});
