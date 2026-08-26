"use strict";

// THE IDLE POLICY HAS TO SURVIVE THE APP BEING CLOSED.
//
// Reported from a real phone: opened the app and it went straight into the
// wallet, no credentials. It was not a break in that day's build — it had
// always been that way, and it worked like this:
//
//   - the session was restored from localStorage at script load, no age check
//   - the ten minute idle logout was a setTimeout held in memory
//   - a setTimeout dies with the page
//
// So closing the app destroyed the only thing enforcing the policy, while the
// refresh token sat on the device for its full seven days. The timeout applied
// only to an app left OPEN — the one case where the customer is holding the
// phone. Closing it, which is the careful thing to do, is what bypassed it.
//
// Behaviour is proven end to end in verification/session-resume.spec.js, which
// drives the real bundle in Chromium across ten cases. This file holds the
// design in place so the pieces cannot be quietly removed: a timestamp that is
// actually written, a gate that fails CLOSED, and a server-side revocation
// that does not weaken the logout endpoint to do its job.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const APP = fs.readFileSync(path.join(ROOT, "pwa", "app.js"), "utf8");
const BUNDLE = fs.readFileSync(path.join(ROOT, "pwa", "app.min.js"), "utf8");
const AUTH_ROUTES = fs.readFileSync(path.join(ROOT, "api", "src", "routes", "auth.routes.js"), "utf8");
const AUTH_SERVICE = fs.readFileSync(path.join(ROOT, "api", "src", "services", "auth-service.js"), "utf8");

test("the stored session is gated on how long the app was closed", () => {
  // The gate runs where it has to run: producing the value `state.auth` is
  // initialised from, not later in boot where something could read the
  // credentials first.
  assert.match(APP, /const state = \{\s*\n\s*auth: restorableAuth\(\),/,
    "state.auth comes from the gate, never straight from storage");
  assert.doesNotMatch(APP, /const state = \{\s*\n\s*auth: readJson\(AUTH_KEY\),/,
    "the ungated restore is gone");

  const gate = APP.slice(APP.indexOf("function restorableAuth"), APP.indexOf("let expiredSessionOnOpen"));
  assert.match(gate, /SESSION_TIMEOUT_MS/, "measured against the same window the live timer uses");
  assert.match(gate, /localStorage\.removeItem\(AUTH_KEY\)/,
    "an expired session is taken off the device, not merely ignored in memory");
});

test("the gate fails closed", () => {
  const gate = APP.slice(APP.indexOf("function restorableAuth"), APP.indexOf("let expiredSessionOnOpen"));
  // A stored session with NO timestamp beside it must be expired, not fresh.
  // That covers the upgrade from the build that never wrote one, and it means
  // deleting the timestamp cannot be used to keep a session alive.
  assert.match(gate, /: Infinity/, "a missing timestamp reads as infinitely idle");
  // A clock wound backwards gives a negative interval, which must not read as
  // "no time has passed".
  assert.match(gate, /idleMs >= 0 && idleMs < SESSION_TIMEOUT_MS/,
    "only a sane forward interval inside the window restores a session");
});

test("the timestamp is written at the moments the mechanism depends on", () => {
  // Three writes matter. Miss any one and the mechanism either expires a live
  // session or fails to expire a dead one.
  assert.match(APP, /function markLastActive\(force = false\)/);
  //   1. when the session starts — or a customer who signs in and immediately
  //      closes the app returns to a session with no stamp, which the gate
  //      reads as expired.
  const save = APP.slice(APP.indexOf("function saveAuth"), APP.indexOf("function clearAuth"));
  assert.match(save, /markLastActive\(true\)/, "signing in stamps the device");
  //   2. on activity, so a session in use never expires under the customer.
  assert.match(APP, /function resetSessionTimers\(\)\s*\{\s*\n[^}]*markLastActive\(\)/,
    "activity refreshes the stamp");
  //   3. on the way to the background, which is the LAST thing that happens
  //      before the in-memory timer is destroyed, and therefore the write the
  //      next open actually reads.
  assert.match(APP, /addEventListener\("pagehide", \(\) => markLastActive\(true\)\)/);
  assert.match(APP, /visibilityState === "hidden"\) markLastActive\(true\)/);
  // Throttled while in use, because activity fires on every scroll and tap and
  // the value only has to be accurate to well inside the window.
  assert.match(APP, /LAST_ACTIVE_WRITE_MS = \d+ \* 1000/);

  // Signing out takes it with the credentials, so a stale stamp cannot outlive
  // the session it described.
  const clear = APP.slice(APP.indexOf("function clearAuth"), APP.indexOf("function clearPersonalDeviceData"));
  assert.match(clear, /localStorage\.removeItem\(LAST_ACTIVE_KEY\)/);
});

test("an expired session is killed at the server too, without weakening logout", () => {
  // Local removal alone leaves a LIVE refresh token in the hands of anyone who
  // copied it off the device. It has to die at the server.
  assert.match(APP, /revokeExpiredSession\(expired\)/);
  const revoke = APP.slice(APP.indexOf("async function revokeExpiredSession"), APP.indexOf("async function boot"));

  // AND IT MUST NOT REACH FOR A SHORTCUT. /v1/auth/logout requires a valid
  // access token on purpose: it used to revoke on a refresh-token hash alone,
  // which meant a leaked refresh token could sign a stranger out. Nothing here
  // may undo that.
  assert.match(AUTH_ROUTES, /router\.post\("\/logout", requireAuth/,
    "logout still requires authentication");
  assert.match(AUTH_SERVICE, /a leaked refresh token can\s*(\/\/)?\s*never be used to sign a stranger out/,
    "and the reason is still recorded");
  assert.match(revoke, /\/v1\/auth\/refresh/, "the stored refresh token is spent normally");
  assert.match(revoke, /Authorization: `Bearer \$\{accessToken\}`/,
    "and logout is called authenticated, like any other client would");

  // Best effort by design: the credentials are already off the device before
  // this runs, so no signal means signed out anyway.
  assert.match(APP, /revokeExpiredSession\(expired\)\.catch\(\(\) => null\)/);
});

test("the customer is told why, and the bundle actually carries the change", () => {
  assert.match(APP, /Signed out after 10 minutes of inactivity/,
    "a sign-in screen with no explanation reads as the app forgetting them");

  // THE TRAP THIS REPOSITORY HAS ALREADY FALLEN INTO. index.html loads
  // app.min.js, not app.js. A fix that lands only in the source ships nothing,
  // and the first run of the browser harness for this very change measured an
  // unrebuilt bundle.
  assert.ok(BUNDLE.includes("titopay_last_active_v1"),
    "app.min.js was rebuilt from app.js — otherwise none of this reaches a customer");
  for (const fn of ["restorableAuth", "markLastActive", "revokeExpiredSession"]) {
    assert.ok(BUNDLE.includes(`function ${fn}(`), `${fn} is in the shipped bundle`);
  }
});
