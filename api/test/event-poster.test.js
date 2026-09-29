"use strict";

// THE EVENT POSTER VALIDATOR.
//
// An uploaded poster arrives as a base64 data URL and is stored in the events
// row, exactly like a profile photo. The validator has to accept a real image,
// reject anything that is not one, and cap the size — the value travels inside
// the 768 KB draft-save request, so an unbounded poster would break the save.
// The end-to-end persistence (a draft keeps its poster) is proven against a real
// database in verification/free-ticketing-live.js.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanEventBanner } = require("../src/services/ticketing-service");

const dataUrl = (bytes) => `data:image/jpeg;base64,${"A".repeat(bytes)}`;

test("a real image data URL is accepted", () => {
  const value = dataUrl(2000);
  assert.equal(cleanEventBanner(value), value);
  assert.ok(cleanEventBanner("data:image/png;base64,iVBORw0KGgo="));
  assert.ok(cleanEventBanner("data:image/webp;base64,UklGRl4="));
});

test("an http(s) poster URL still works, and is capped", () => {
  assert.equal(cleanEventBanner("https://cdn.example.com/poster.jpg"), "https://cdn.example.com/poster.jpg");
  assert.equal(cleanEventBanner(`https://x.example/${"a".repeat(2000)}`).length, 800);
});

test("an oversized poster is refused rather than stored", () => {
  // Above 700 KB it cannot travel in the request body, so it is a clean 413.
  assert.throws(() => cleanEventBanner(dataUrl(750 * 1024)), (error) => {
    assert.equal(error.statusCode, 413);
    return /too large/i.test(error.message);
  });
});

test("anything that is not an image or a URL becomes empty, never stored raw", () => {
  assert.equal(cleanEventBanner(""), "");
  assert.equal(cleanEventBanner(null), "");
  assert.equal(cleanEventBanner("javascript:alert(1)"), "", "a script URL must not survive");
  assert.equal(cleanEventBanner("data:text/html;base64,PHNjcmlwdD4="), "", "a non-image data URL is rejected");
  assert.equal(cleanEventBanner("<script>"), "");
});
