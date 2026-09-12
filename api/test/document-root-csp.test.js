"use strict";

// A POLICY APPLIES TO A DIRECTORY, NOT TO THE FILE YOU TESTED.
//
// pwa/.htaccess sends a Content-Security-Policy header carrying script-src
// 'self'. That header was verified against pwa/index.html — which already
// declared the identical policy in a <meta> tag, and was therefore the one file
// under that root that COULD NOT regress. The header reaches every file in the
// directory.
//
// style-src has since gained 'unsafe-inline', deliberately. The app builds its
// screens in JavaScript and sets style attributes as it goes — 116 of them —
// and the meta tag was loosened to allow that. The header was NOT updated to
// match, so the stricter of the two won and those styles were stripped on the
// real server: the guided tour arrived at a customer's phone with its layout
// missing. The two now agree again. script-src stays 'self' — that is the
// directive that stops injected code, and nothing about it has changed.
//
// pwa/verify-email/index.html had no meta CSP and an inline <style>, so it had
// been running unpoliced. The header refused its entire stylesheet: 13 rules to
// 0, grid layout to browser-default block, and the page every new customer
// lands on from their verification email rendered as raw HTML. It still worked
// — its script is external — which is exactly why nothing caught it.
//
// This is the guard against repeating that. It is a source check rather than a
// browser check on purpose: it runs in the ordinary suite, on every file, in
// milliseconds, and it fails when somebody adds a new page rather than when a
// customer opens one.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..");

function htaccessPolicy(root) {
  const file = path.join(REPO, root, ".htaccess");
  if (!fs.existsSync(file)) return "";
  const source = fs.readFileSync(file, "utf8");
  const match = source.match(/Header\s+always\s+set\s+Content-Security-Policy\s+"([^"]+)"/i);
  return match ? match[1] : "";
}

function htmlFiles(root) {
  const base = path.join(REPO, root);
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".html")) found.push(full);
    }
  })(base);
  return found;
}

// An inline block is one with content of its own. <script src=...></script> is
// external and unaffected by script-src 'self'.
function inlineBlocks(html) {
  const styles = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
  const scripts = (html.match(/<script(?![^>]*\ssrc\s*=)[^>]*>[\s\S]*?<\/script>/gi) || [])
    .filter((block) => block.replace(/<\/?script[^>]*>/gi, "").trim().length > 0);
  return { styles: styles.length, scripts: scripts.length };
}

test("no page under pwa/ carries inline script, because the root policy forbids it", () => {
  const policy = htaccessPolicy("pwa");
  assert.ok(policy, "pwa/.htaccess must send a CSP — that is the whole premise of this test");
  assert.match(policy, /script-src 'self'/, "if script-src ever loosens, that is a security decision, not a styling one");

  const offenders = [];
  for (const file of htmlFiles("pwa")) {
    const { scripts } = inlineBlocks(fs.readFileSync(file, "utf8"));
    if (scripts) offenders.push(`${path.relative(REPO, file)} (${scripts} inline <script>)`);
  }

  assert.deepEqual(offenders, [],
    "these pages will run unscripted in production:\n  " + offenders.join("\n  ") +
    "\nMove the block into a .js file beside the page and link it.");
});

test("the pwa header and the pwa meta tag carry the same policy", () => {
  // The bug this catches has already happened once: the meta tag was loosened
  // to let the app style what it builds, the header was left strict, and the
  // browser enforced both — so the strict one silently won and screens reached
  // customers with their layout stripped. Neither file is readable alone; the
  // only truth is that they agree.
  const header = htaccessPolicy("pwa");
  const html = fs.readFileSync(path.join(REPO, "pwa", "index.html"), "utf8");
  // The policy itself contains apostrophes ('self'), so the capture has to be
  // anchored on the attribute's own quote character rather than "either quote".
  const meta = (html.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i)
    || html.match(/<meta[^>]+http-equiv='Content-Security-Policy'[^>]*content='([^']+)'/i)
    || [])[1];
  assert.ok(meta, "pwa/index.html must declare a meta CSP");

  const directives = (policy) => Object.fromEntries(
    policy.split(";").map((part) => part.trim()).filter(Boolean)
      .map((part) => { const [name, ...values] = part.split(/\s+/); return [name, values.join(" ")]; })
  );
  const headerDirectives = directives(header);
  const metaDirectives = directives(meta);

  for (const [name, value] of Object.entries(metaDirectives)) {
    assert.equal(headerDirectives[name], value,
      `${name} differs between pwa/index.html and pwa/.htaccess — the browser enforces both, so the stricter one wins silently`);
  }
  // frame-ancestors is the one directive that is header-only: a meta tag
  // cannot carry it, which is why the header exists at all.
  assert.match(header, /frame-ancestors 'none'/);
});

test("every page under pwa/ is actually covered, so none is silently exempt", () => {
  // A count, so that adding a page is a deliberate act. verify-email was added
  // at some point without anyone re-checking the policy against it.
  const files = htmlFiles("pwa").map((f) => path.relative(REPO, f)).sort();
  assert.deepEqual(files, [
    "pwa/index.html",
    "pwa/offline.html",
    "pwa/verify-email/index.html"
  ], "a page was added or removed under pwa/ — confirm it renders under the root CSP, then update this list");
});

test("HR's policy stays within what a fully-inline portal can take", () => {
  // The opposite failure. hr/index.html IS the application — six inline
  // <script> blocks and a <style>. script-src or style-src here blanks the
  // portal for staff. The four directives it does send are unrelated to inline
  // code, and were confirmed in a browser to leave all 513 rules parsing.
  const policy = htaccessPolicy("hr");
  assert.ok(policy, "HR should send the directives that cost it nothing");
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /base-uri 'self'/);
  assert.match(policy, /form-action 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.doesNotMatch(policy, /script-src/,
    "hr/index.html is 100% inline script — script-src blanks the portal");
  assert.doesNotMatch(policy, /style-src/,
    "hr/index.html carries an inline <style> — style-src strips the portal's appearance");

  const { styles, scripts } = inlineBlocks(fs.readFileSync(path.join(REPO, "hr", "index.html"), "utf8"));
  assert.ok(scripts > 0 || styles > 0,
    "if HR's inline code has been moved into files, it can now take the full policy — tighten it");
});

test("all three document roots refuse framing, and by a response header", () => {
  // frame-ancestors is ignored in a <meta> tag. Only a header counts.
  for (const root of ["pwa", "hr", "admin"]) {
    const source = fs.readFileSync(path.join(REPO, root, ".htaccess"), "utf8");
    assert.match(source, /Header\s+always\s+set\s+X-Frame-Options\s+"DENY"/i, `${root} may be framed`);
    assert.match(htaccessPolicy(root), /frame-ancestors 'none'/, `${root} has no frame-ancestors in a header`);
  }
});

test("all three document roots upgrade plain HTTP, so their HSTS is ever delivered", () => {
  // A browser arriving over HTTP never receives Strict-Transport-Security, so
  // without the redirect the header protects only visitors who were already
  // safe. admin has had these two lines in production since it shipped.
  for (const root of ["pwa", "hr", "admin"]) {
    const source = fs.readFileSync(path.join(REPO, root, ".htaccess"), "utf8");
    assert.match(source, /RewriteCond\s+%\{HTTPS\}\s+!=on/, `${root} does not force HTTPS`);
    assert.match(source, /RewriteRule\s+\^\s+https:\/\/%\{HTTP_HOST\}%\{REQUEST_URI\}\s+\[L,R=301\]/, `${root} has no upgrade rule`);
    assert.match(source, /Strict-Transport-Security/, `${root} sends no HSTS`);
  }
});
