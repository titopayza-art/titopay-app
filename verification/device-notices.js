"use strict";
// WHAT REACHES A LOCKED PHONE, AND WHAT IT SAYS.
//
// Two reported faults:
//   1. Only a login ever appeared on the device. Money arriving, money
//      leaving, a child asking for money - all sat silently in the app until
//      it was opened, which is when they were no longer needed.
//   2. The login notice printed navigator.userAgent, so a lock screen read
//      "recorded from Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)
//      AppleWebKit/605.1.15 (KHT". A debug string, on a customer's phone.
//
//   node verification/device-notices.js      (exits non-zero on any failure)

process.env.NODE_ENV = "test";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = __dirname + "/..";
const APP = fs.readFileSync(path.join(REPO, "pwa", "app.js"), "utf8");
const AUTH = fs.readFileSync(path.join(REPO, "api", "src", "services", "auth-service.js"), "utf8");

let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// ---- 1. the words on the lock screen --------------------------------------
const fnSource = AUTH.slice(AUTH.indexOf("function friendlyDeviceName"), AUTH.indexOf("async function queueLoginNotice"));
// In strict mode eval keeps its own scope, so the declaration would not escape.
// Compile it instead and hand back the function itself.
const friendlyDeviceName = new Function(`${fnSource}\nreturn friendlyDeviceName;`)();
const cases = [
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHT", "your iPhone"],
  ["Mozilla/5.0 (Linux; Android 14; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36", "an Android phone (Chrome)"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120", "a Windows PC (Edge)"],
  ["TitoPay PWA", "TitoPay PWA"],
  ["", "a web browser"]
];
for (const [input, expected] of cases) {
  const actual = friendlyDeviceName(input);
  check(`device name: ${JSON.stringify(input.slice(0, 34))}`, actual === expected, `-> ${JSON.stringify(actual)}`);
}
check("no raw agent can survive into the message",
  !cases.some(([input]) => /Mozilla|AppleWebKit/.test(friendlyDeviceName(input))));
check("the login body uses the friendly name",
  /const device=friendlyDeviceName\(payload\.deviceName\)/.test(AUTH));

// ---- 2. what reaches the device -------------------------------------------
const set = (APP.match(/const DEVICE_NOTICE_TYPES = new Set\(\[[\s\S]*?\]\);/) || [""])[0];
check("money in and money out are announced", /"payment-in", "payment-out"/.test(set));
check("a child's request is announced", /titokids_request/.test(set));
check("a co-parent invitation is announced", /titokids_guardian_invite/.test(set));
check("a login is still announced", /login_notification/.test(set));

const gate = APP.slice(APP.indexOf("function shouldRaiseDeviceNotice("));
const gateBody = gate.slice(0, gate.indexOf("\n}") + 2);
check("nothing interrupts somebody already using the app",
  /document\.visibilityState === "visible"\) return false/.test(gateBody));
check("a login overrides that, because it may not have been them",
  /item\.notification_type === "login_notification" \|\| shouldRaiseDeviceNotice\(notice\)/.test(APP));
check("money movements raise one from the transaction sync",
  /if \(isNew && !firstSync && shouldRaiseDeviceNotice\(item\)\)/.test(APP));
check("a money alert opens Activity, not Profile",
  /notice\.metadata\?\.category === "payment" \? "activity"/.test(APP));

console.log(bad ? `\n${bad} FAILURE(S)` : "\nDEVICE NOTICES VERIFIED");
process.exit(bad ? 1 : 0);
