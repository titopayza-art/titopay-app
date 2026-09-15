"use strict";

// WHAT A TITOPAY PASSWORD OR PIN HAS TO BE, CHECKED ON THE SERVER.
//
// The app asked for at least 4 characters with minlength="4". The API asked
// for nothing at all: a live probe registered a working wallet account with
// the password "a", and another with "password". A browser attribute is a
// suggestion to a browser; the API is a public endpoint and anyone can call
// it directly, so the rule has to live here.
//
// TWO RULES THAT MATTER MORE THAN THE LENGTH:
//
// 1. This is NEVER applied at sign-in. A customer who already has a weaker
//    PIN keeps signing in with it. Enforcing a policy at login would lock
//    people out of their own money to fix a problem they did not create.
//    Registration and password change only.
//
// 2. A four digit PIN stays a four digit PIN. That is a product decision and
//    tightening it to eight characters would break the design rather than
//    secure it. What a short PIN needs is the guessing ceiling to actually
//    hold, which is the lockout fix in auth-service, plus this refusal of the
//    handful of PINs that real people pick far more often than chance. "1234"
//    alone is roughly one in ten real world PINs; the list below is small,
//    but it removes the guesses an attacker would try first.

const MINIMUM_PIN_LENGTH = 4;
const MINIMUM_BUSINESS_PASSWORD_LENGTH = 8;

// Every 4 digit run that is the same digit repeated, or a straight ascending
// or descending sequence, plus the short list of PINs that appear at the top
// of every leaked-PIN study. Generated rather than typed out so the intent
// stays readable and nothing is missed by hand.
const WEAK_PINS = new Set([
  ...Array.from({ length: 10 }, (_, digit) => String(digit).repeat(4)),
  ...Array.from({ length: 7 }, (_, start) => [0, 1, 2, 3].map((step) => start + step).join("")),
  ...Array.from({ length: 7 }, (_, start) => [3, 2, 1, 0].map((step) => start + step).join("")),
  "1004", "2000", "2001", "2020", "1010", "1122", "1212", "1313", "6969", "1313", "4711", "1230"
]);

// Passwords that appear at the top of every breach corpus. Compared after
// lowercasing, so "Password" and "PASSWORD" are refused too.
const WEAK_PASSWORDS = new Set([
  "password", "password1", "passw0rd", "12345678", "123456789", "1234567890",
  "qwertyui", "qwerty123", "abc12345", "iloveyou", "letmein1", "welcome1",
  "admin123", "titopay1", "titopay123", "changeme", "trustno1", "football",
  "baseball", "starwars", "whatever", "sunshine", "princess", "monkey12"
]);

function isAllDigits(value) {
  return /^\d+$/.test(value);
}

// The message a customer reads. It says what to do, never what was wrong with
// the specific thing they typed, and never how the check works.
function pinLabel(accountType) {
  return accountType === "business" ? "password" : "PIN or password";
}

// Returns nothing when the value is acceptable, and a customer-safe sentence
// when it is not. The caller turns that into a 400.
function passwordPolicyProblem(value, { accountType = "personal", identifiers = [] } = {}) {
  const password = typeof value === "string" ? value : "";
  const label = pinLabel(accountType);

  if (!password) return `Enter a ${label}.`;

  if (accountType === "business") {
    if (password.length < MINIMUM_BUSINESS_PASSWORD_LENGTH) {
      return `Use a password of at least ${MINIMUM_BUSINESS_PASSWORD_LENGTH} characters.`;
    }
  } else if (password.length < MINIMUM_PIN_LENGTH) {
    return `Use a ${label} of at least ${MINIMUM_PIN_LENGTH} characters.`;
  }

  if (isAllDigits(password)) {
    // A digits-only secret is a PIN however long it is, so the sequence and
    // repetition rules apply at every length, not only at four.
    if (WEAK_PINS.has(password)) {
      return "That PIN is one of the most commonly used. Choose a less predictable one.";
    }
    if (new Set(password).size === 1) {
      return "A PIN cannot be the same digit repeated. Choose a less predictable one.";
    }
    const ascending = password.split("").every((digit, index, all) =>
      index === 0 || Number(digit) === Number(all[index - 1]) + 1);
    const descending = password.split("").every((digit, index, all) =>
      index === 0 || Number(digit) === Number(all[index - 1]) - 1);
    if (ascending || descending) {
      return "A PIN cannot be a run of consecutive digits. Choose a less predictable one.";
    }
  }

  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    return "That password appears in public lists of leaked passwords. Choose another one.";
  }

  // The secret must not simply repeat something already on the account. An
  // email address or a username is public enough to be the first thing tried.
  for (const identifier of identifiers) {
    const candidate = String(identifier || "").trim().toLowerCase();
    if (!candidate) continue;
    const localPart = candidate.split("@")[0];
    if (password.toLowerCase() === candidate || (localPart.length >= 4 && password.toLowerCase() === localPart)) {
      return `Your ${label} cannot be the same as your username, email or phone number.`;
    }
  }

  return null;
}

module.exports = {
  passwordPolicyProblem,
  MINIMUM_PIN_LENGTH,
  MINIMUM_BUSINESS_PASSWORD_LENGTH
};
