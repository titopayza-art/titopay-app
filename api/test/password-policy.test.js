"use strict";

// TWO THINGS A LIVE PROBE BROKE, PINNED SO THEY STAY FIXED.
//
// 1. The API accepted the password "a" and registered a working wallet
//    account. The app's minlength="4" is a browser hint, not a rule.
// 2. Account lockout was checked AFTER the password was verified, so a wrong
//    guess against a locked account returned 401 and a correct one returned
//    423. That difference told an attacker they had found the password.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { passwordPolicyProblem } = require("../src/lib/password-policy");
const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const AUTH = read("src", "services", "auth-service.js");
const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

test("the passwords a live probe got through are refused", () => {
  // Each of these registered a real account before the policy existed.
  for (const rejected of ["a", "ab", "abc", "1234", "password", "PASSWORD", "Password"]) {
    assert.ok(passwordPolicyProblem(rejected), `"${rejected}" must be refused`);
  }
});

test("a four digit PIN is still a four digit PIN", () => {
  // The product uses a short PIN on purpose. The policy must not quietly
  // turn it into a password, or it breaks the design instead of securing it.
  assert.equal(passwordPolicyProblem("8305"), null);
  assert.equal(passwordPolicyProblem("4907"), null);
});

test("the PINs an attacker tries first are refused", () => {
  for (const weak of ["0000", "1111", "9999", "1234", "2345", "9876", "4321", "1212", "6969", "1004"]) {
    assert.ok(passwordPolicyProblem(weak), `PIN ${weak} must be refused`);
  }
  // Length does not rescue a sequence: the rule applies to any digits-only
  // secret, not only to four of them.
  assert.ok(passwordPolicyProblem("123456"));
  assert.ok(passwordPolicyProblem("77777777"));
});

test("business accounts carry a real password, personal accounts a PIN", () => {
  assert.ok(passwordPolicyProblem("Str0ng!", { accountType: "business" }), "seven characters is short for a business");
  assert.equal(passwordPolicyProblem("Str0ng!Pass", { accountType: "business" }), null);
  // The app must ask for the same thing the API enforces, or a customer meets
  // a server error the form told them would not happen.
  assert.match(APP, /minlength="\$\{isBusiness \? 8 : 4\}"/);
});

test("the secret cannot simply repeat something already on the account", () => {
  const identifiers = ["thabo@example.co.za", "+27761234567", "thabo"];
  assert.ok(passwordPolicyProblem("thabo@example.co.za", { identifiers }));
  assert.ok(passwordPolicyProblem("thabo", { identifiers }));
  assert.equal(passwordPolicyProblem("Str0ng!Unrelated", { identifiers }), null);
});

test("the policy guards registration and reset, and NEVER sign-in", () => {
  // Both doors into a password are guarded...
  assert.match(AUTH, /async function register[\s\S]{0,2000}passwordPolicyProblem\(payload\.password/);
  assert.match(AUTH, /async function confirmPasswordReset[\s\S]{0,600}passwordPolicyProblem\(newPassword/);
  // ...and sign-in is not. A customer whose PIN predates the policy must keep
  // getting into their own wallet. Enforcing a policy at login would lock
  // people out of their money to fix something they did not do.
  const login = AUTH.slice(AUTH.indexOf("async function login("));
  const body = login.slice(0, login.indexOf("\nasync function "));
  assert.doesNotMatch(body, /passwordPolicyProblem/,
    "a password policy must never be applied at sign-in");
});

test("a locked account answers the same way whatever the password is", () => {
  const login = AUTH.slice(AUTH.indexOf("async function login("));
  const body = login.slice(0, login.indexOf("\nasync function "));
  const lockAt = body.indexOf("locked_until");
  const verifyAt = body.indexOf("verifyPassword(");
  assert.ok(lockAt > -1 && verifyAt > -1, "both checks exist");
  assert.ok(lockAt < verifyAt,
    "the lock must be checked BEFORE the password, or a correct guess is distinguishable from a wrong one");
  assert.match(body, /throw new AppError\(423/);
});

test("the HR portal keeps the ordering it always had", () => {
  // hr-service was the house style this fix follows. If it ever regresses,
  // the same oracle reopens on the staff portal.
  const HR = read("src", "services", "hr-service.js");
  const fn = HR.slice(HR.indexOf("FROM hr_users u"));
  const lockAt = fn.indexOf("locked_until");
  const verifyAt = fn.indexOf("verifyPassword(");
  assert.ok(lockAt > -1 && verifyAt > -1 && lockAt < verifyAt);
});
