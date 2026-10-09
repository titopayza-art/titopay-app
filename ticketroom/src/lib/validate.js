// Small declarative validator. Each rule is (value) => cleaned value, throwing
// a message string on failure. Unknown fields are dropped, never passed on.
const { invalid } = require("./errors");

const EMPTY = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
class Fail extends Error {}
const fail = (m) => { throw new Fail(m); };

function rule(fn, { optional = false, fallback } = {}) {
  return (v) => {
    if (EMPTY(v)) {
      if (optional) return fallback;
      fail("This field is required.");
    }
    return fn(v);
  };
}

const r = {
  str: ({ min = 1, max = 200, pattern, message, ...o } = {}) => rule((v) => {
    if (typeof v !== "string") fail("Must be text.");
    const s = v.trim().replace(/\s+/g, max > 300 ? " " : " ");
    if (s.length < min) fail(`Must be at least ${min} characters.`);
    if (s.length > max) fail(`Must be at most ${max} characters.`);
    if (pattern && !pattern.test(s)) fail(message || "Invalid format.");
    return s;
  }, o),
  text: ({ max = 5000, ...o } = {}) => rule((v) => {
    if (typeof v !== "string") fail("Must be text.");
    const s = v.replace(/\r\n/g, "\n").trim();
    if (s.length > max) fail(`Must be at most ${max} characters.`);
    return s;
  }, o),
  email: (o = {}) => rule((v) => {
    const s = String(v).trim().toLowerCase();
    if (s.length > 254 || !/^[^\s@<>()"',;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) fail("Enter a valid email address.");
    return s;
  }, o),
  // South African mobile numbers, normalised to +27XXXXXXXXX.
  phone: (o = {}) => rule((v) => {
    const d = String(v).replace(/[\s()-]/g, "");
    const m = d.match(/^(?:\+?27|0)([6-8]\d{8})$/);
    if (!m) fail("Enter a valid South African mobile number.");
    return `+27${m[1]}`;
  }, o),
  password: (o = {}) => rule((v) => {
    if (typeof v !== "string" || v.length < 10) fail("Use at least 10 characters.");
    if (v.length > 200) fail("Too long.");
    return v;
  }, o),
  int: ({ min = -Infinity, max = Infinity, ...o } = {}) => rule((v) => {
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (!Number.isInteger(n)) fail("Must be a whole number.");
    if (n < min) fail(`Must be at least ${min}.`);
    if (n > max) fail(`Must be at most ${max}.`);
    return n;
  }, o),
  bool: (o = {}) => rule((v) => {
    if (v === true || v === "true" || v === "on" || v === 1) return true;
    if (v === false || v === "false" || v === 0) return false;
    fail("Must be true or false.");
  }, { optional: true, fallback: false, ...o }),
  uuid: (o = {}) => rule((v) => {
    const s = String(v).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) fail("Invalid identifier.");
    return s;
  }, o),
  oneOf: (values, o = {}) => rule((v) => {
    if (!values.includes(v)) fail(`Must be one of: ${values.join(", ")}.`);
    return v;
  }, o),
  date: (o = {}) => rule((v) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) fail("Enter a valid date and time.");
    return d.toISOString();
  }, o),
  idemKey: (o = {}) => r.str({ min: 8, max: 80, pattern: /^[A-Za-z0-9_.:-]+$/, message: "Invalid idempotency key.", ...o }),
  array: (item, { min = 0, max = 50, ...o } = {}) => rule((v) => {
    if (!Array.isArray(v)) fail("Must be a list.");
    if (v.length < min) fail(`Add at least ${min}.`);
    if (v.length > max) fail(`At most ${max} allowed.`);
    return v.map((x, i) => {
      try { return item(x); } catch (e) { if (e instanceof Fail) fail(`Item ${i + 1}: ${e.message}`); throw e; }
    });
  }, o),
  object: (shape, o = {}) => rule((v) => {
    if (typeof v !== "object" || Array.isArray(v)) fail("Invalid value.");
    const out = {};
    for (const [k, fn] of Object.entries(shape)) {
      try { const c = fn(v[k]); if (c !== undefined) out[k] = c; } catch (e) { if (e instanceof Fail) fail(`${k}: ${e.message}`); throw e; }
    }
    return out;
  }, o),
};

function check(input, shape) {
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  const errors = {};
  for (const [k, fn] of Object.entries(shape)) {
    try {
      const c = fn(src[k]);
      if (c !== undefined) out[k] = c;
    } catch (e) {
      if (e instanceof Fail) errors[k] = e.message;
      else throw e;
    }
  }
  if (Object.keys(errors).length) throw invalid(errors);
  return out;
}

module.exports = { r, check };
