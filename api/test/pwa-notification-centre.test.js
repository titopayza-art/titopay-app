"use strict";

// TWO REPORTED FAULTS IN THE NOTIFICATION CENTRE, HELD DOWN.
//
// 1. "Notifications go on the wrong section." Two causes: the classifier
//    could return "account" while no Account chip existed (those notices were
//    only visible under All), and an EVENT ticket's ticketId satisfied a
//    Messages test written for SUPPORT ticket references, so buying a ticket
//    filed the payment under Messages.
// 2. "Deleted notifications keep coming back." The cleared-at marker lived
//    under the same storage prefix the sign-out privacy wipe removes, so one
//    sign-out forgot the clear and the server feed re-delivered everything.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

test("every category the classifier can produce has a filter chip", () => {
  const fn = APP.slice(APP.indexOf("function notificationCategory("));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  const produced = [...body.matchAll(/return "([a-z]+)";?/g)].map((m) => m[1]);
  const filters = (APP.match(/const NOTIFICATION_FILTERS = \[[\s\S]*?\n\];/) || [""])[0];
  const chips = [...filters.matchAll(/\["([a-z]+)"/g)].map((m) => m[1]);
  for (const category of produced) {
    assert.ok(chips.includes(category),
      `the classifier files notices under "${category}" but no such chip exists - a drawer with no handle`);
  }
});

test("an event ticket purchase is a payment, not a message", () => {
  const fn = APP.slice(APP.indexOf("function notificationCategory("));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /serverType === "ticket_purchase"[\s\S]{0,40}return "payments"/);
  assert.doesNotMatch(body, /metadata\.ticketId/,
    "an event ticket's id must not satisfy the support-ticket Messages test");
});

test("the cleared-inbox marker survives the sign-out privacy wipe", () => {
  const key = APP.slice(APP.indexOf("function notificationClearedAtKey("));
  const keyBody = key.slice(0, key.indexOf("\n}") + 2);
  assert.match(keyBody, /titopay_notices_cleared_v1/,
    "the marker needs its own prefix - it holds one timestamp, nothing personal");

  const wipe = APP.slice(APP.indexOf("function clearPersonalDeviceData("));
  const wipeBody = wipe.slice(0, wipe.indexOf("\n}") + 2);
  assert.doesNotMatch(wipeBody, /titopay_notices_cleared_v1/,
    "the wipe list must not cover the marker, or every clear is forgotten at sign-out");

  // And migration: a marker written under the old wiped key still counts.
  assert.match(APP, /`\$\{notificationStorageKey\(\)\}:cleared-at`/,
    "the legacy key is still read once, so an existing clear is not lost in the upgrade");
});

test("clearing the inbox clears it on the server too", () => {
  const fn = APP.slice(APP.indexOf("function clearNotifications("));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /api\("\/v1\/chat\/notifications\/read", \{ method: "POST"/,
    "without the server call, the feed re-serves the same items as unread");
});

// 3. "Can deleted messages stay gone." The local marker protects one browser.
//    A new phone, a reinstall or a cleared browser has no marker, and the feed
//    used to return the whole read history - so the clear looked undone. The
//    server now keeps its own cleared-at stamp per user.

test("the server remembers a cleared inbox, so no device gets the history back", () => {
  const routes = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "chat.routes.js"), "utf8");

  // The feed excludes everything from before the user's clear stamp.
  assert.match(routes, /created_at > COALESCE\(\s*\(SELECT cleared_at FROM notification_clears WHERE user_id = \$1\)/,
    "GET /notifications must filter out notices older than the clear stamp");

  // The Clear-inbox signal (empty ids) stamps the marker; a single-id read never does.
  const read = routes.slice(routes.indexOf('"/notifications/read"'));
  const readBody = read.slice(0, read.indexOf("\nrouter."));
  assert.match(readBody, /if \(!ids\.length\)[\s\S]{0,200}markNotificationsCleared/,
    "an empty ids array is the Clear inbox button - it must stamp the server marker");

  const service = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "notification-service.js"), "utf8");
  assert.match(service, /notification_clears \(\s*user_id UUID PRIMARY KEY/,
    "one stamp per user: the clear binds the account, not a device");
  assert.match(service, /ON CONFLICT \(user_id\) DO UPDATE SET cleared_at/,
    "clearing again moves the stamp forward instead of failing");
});
