"use strict";

// THE QUICK REPLIES HAVE TO SURVIVE A BUSY DESK.
//
// Reported from the live console: the Quick replies panel flickered and
// disappeared while an agent was working a conversation. Both symptoms came
// from one thing — renderSupport() replaces #page-content wholesale, and it
// was driven straight off the support socket, so a queue taking a message
// every couple of seconds tore the panel down and rebuilt it that often.
//
//   disappearing  the disclosure state was the ONE piece of the workspace the
//                 refresh did not restore. The draft, the caret, the focus and
//                 the thread scroll were all captured and put back; the open
//                 panel was not, so it snapped shut under the agent.
//   flicker       one full repaint per arriving message.
//
// Behaviour is proven in Chromium in verification/support-quick-replies.spec.js,
// which opens the panel and drives twelve refreshes through the real
// captureSupportWorkspace() and renderSupportConversationView(). This file
// holds the two mechanisms in place.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const CONSOLE = fs.readFileSync(path.join(ROOT, "admin", "assets", "admin.js"), "utf8");

test("the quick replies keep their open state across a refresh", () => {
  // Captured from the live element, so it is right however the panel was
  // opened — the summary, the keyboard, or the manage button opening it.
  const capture = CONSOLE.slice(CONSOLE.indexOf("function captureSupportWorkspace"),
    CONSOLE.indexOf("function monitorAge"));
  assert.match(capture, /details\.support-quick-replies/,
    "the refresh captures the disclosure state");
  assert.match(capture, /PAGE_EXPORTS\.sqrOpen = quickReplies\.open/);

  // AND IT IS CAPTURED BEFORE THE COMPOSER'S EARLY RETURN. That return fires
  // whenever the agent is on the queue list rather than inside a conversation;
  // capturing after it would silently do nothing half the time.
  const composerReturn = capture.indexOf("if (!composer) return;");
  const quickCapture = capture.indexOf("PAGE_EXPORTS.sqrOpen");
  assert.ok(quickCapture !== -1 && composerReturn !== -1);
  assert.ok(quickCapture < composerReturn,
    "the disclosure state is captured before the early return, or it is skipped");

  // And put back on the way out.
  assert.match(CONSOLE, /<details class="support-quick-replies" \$\{PAGE_EXPORTS\.sqrManaging \|\| PAGE_EXPORTS\.sqrOpen \? "open" : ""\}>/,
    "the panel reopens itself when the agent had it open");
});

test("a burst of support messages causes one repaint, not one per message", () => {
  assert.match(CONSOLE, /function scheduleSupportRefresh\(\)/);
  const scheduler = CONSOLE.slice(CONSOLE.indexOf("function scheduleSupportRefresh()"),
    CONSOLE.indexOf("async function renderSupport()"));
  // Coalesced: a second message inside the window rides the pending repaint.
  assert.match(scheduler, /if \(supportRefreshTimer\) return;/);
  assert.match(scheduler, /setTimeout\(/);
  // And it re-checks the page on the way out, so navigating away mid-window
  // cannot repaint a page the agent has already left.
  assert.match(scheduler, /const stillHere/);

  // EVERY PASSIVE REFRESH GOES THROUGH IT. A single missed call site puts the
  // flicker straight back on a busy desk.
  const socketAndPoll = CONSOLE.slice(0, CONSOLE.indexOf("function scheduleSupportRefresh"));
  assert.doesNotMatch(socketAndPoll, /renderSupport\(\)\.catch\(\(\) => null\)/,
    "no socket or poll path still repaints directly");
  assert.ok((CONSOLE.match(/scheduleSupportRefresh\(\)/g) || []).length >= 4,
    "the socket and both fallback polls are routed through the scheduler");
});

test("a deliberate action still repaints at once", () => {
  // Coalescing is only correct for passive refreshes. Opening a conversation,
  // sending a reply or taking one over must not wait 400ms to show what the
  // agent just did.
  const direct = (CONSOLE.match(/await renderSupport\(\)/g) || []).length;
  assert.ok(direct > 0, "deliberate actions call renderSupport directly");
});

test("both copies of admin.js are the same file", () => {
  // admin/index.html loads the assets copy; a fix landing in only one of them
  // is a fix nobody runs.
  const root = fs.readFileSync(path.join(ROOT, "admin", "admin.js"), "utf8");
  assert.equal(root, CONSOLE, "admin/admin.js and admin/assets/admin.js have drifted");
});
