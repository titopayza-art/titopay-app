// Gate scanner and registration (tag) desk for event staff.
import { svgIcon, html, render, $, $$, get, post, header, plural, requireUser, toast, fmtTime, empty, spinner, emailLinkPage, wrongAccountPage, accountType, features, installPrompt, pullToRefresh } from "/assets/core.js";
import { deskApp } from "/assets/cashdesk.js";
import { boxOfficeApp } from "/assets/boxoffice.js?build=2026-10-22-phases";
import { Camera, readNfc, nfcSupported, beep } from "/assets/reader.js";
import * as offline from "/assets/scan-offline.js";

const main = $("#main");
// The top-up desk is offered only where the server has it (features.cashDesk).
let DESK = false;
let EVENT = null, cam = null, nfcAbort = null, mode = "gate", deskTicket = null;
// "Open the scanner" on the admin portal's Test event page: /scan?test=<event id>.
const TEST_EVENT = new URLSearchParams(location.search).get("test");

const VERDICT = {
  admitted: ["ok", "ADMIT"], already_used: ["no", "ALREADY SCANNED"], invalid: ["no", "NOT VALID"], test_ticket: ["no", "TEST TICKET"], wrong_event: ["warn", "WRONG EVENT"],
  revoked: ["no", "REVOKED"], refunded: ["no", "REFUNDED"], resold: ["no", "RESOLD"], listed: ["no", "ON RESALE"], event_not_live: ["warn", "NOT OPEN"], offline: ["warn", "NO CONNECTION"],
  replaced: ["no", "REPLACED"], refund_pending: ["no", "REFUND IN PROGRESS"],
};
// The event's age rule, in the words the gate needs: "18+ only: check ID".
const ageRule = (a) => (a ? `${/^\d+$/.test(String(a)) ? `${a}+` : a} only: check ID` : "");
// No answer, or the server too busy to answer: check against the phone's list.
const unreachable = (err) => err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504;

async function pickEvent() {
  document.body.classList.remove("scan-live");
  const { events } = await get("/api/staff/events");
  if (!events.length) return render(main, html`<div class="card">${empty("You aren't assigned to any live events. Ask the organiser to add you as staff.")}</div>`);
  const chosen = TEST_EVENT && events.find((e) => e.id === TEST_EVENT);
  if (chosen) { localStorage.setItem("tr_scan_event", chosen.id); return start(chosen); }
  const saved = localStorage.getItem("tr_scan_event");
  const found = events.find((e) => e.id === saved);
  if (found && events.length === 1) return start(found);
  render(main, html`<h1>Choose event</h1><div class="stack">${events.map((e) => html`<button class="card btn-block row between" data-ev="${e.id}"><span><strong>${e.title}</strong><br><span class="small muted">${e.venue_name} · ${fmtTime(e.starts_at)}</span></span>${svgIcon("arrow", 18)}</button>`)}</div>`);
  $$("[data-ev]").forEach((b) => b.addEventListener("click", () => { const ev = events.find((e) => e.id === b.dataset.ev); localStorage.setItem("tr_scan_event", ev.id); start(ev); }));
}

function start(ev) {
  EVENT = ev; STATS = null;
  offline.forgetOthers(ev.id);
  if (!ev.can_scan && ev.can_sell_tickets) return boxOfficeApp(main, ev.id, { onBack: () => { localStorage.removeItem("tr_scan_event"); pickEvent(); }, backLabel: "Change event" });
  mode = ev.can_scan ? "gate" : "desk";
  // The tools this person has at this event; tabs only when there is a choice.
  const tools = [ev.can_scan ? html`<button role="tab" aria-selected="${mode === "gate"}" data-mode="gate">Gate</button>` : "", ev.can_manage_tags ? html`<button role="tab" aria-selected="${mode === "desk"}" data-mode="desk">Tag desk</button>` : "",
    DESK && ev.can_manage_tags && ev.cashless_enabled ? html`<button role="tab" aria-selected="false" data-topup>Top-up desk</button>` : "", ev.can_sell_tickets ? html`<button role="tab" aria-selected="false" data-boxoffice>Box office</button>` : ""].filter(Boolean);
  // On a phone the scanner is a full-screen tool: a slim bar with the event, the
  // counts under it, one big Scan button, and the camera over the whole screen.
  document.body.classList.add("scan-live");
  render(main, html`<div class="scan-top"><img src="/assets/logo-mark.svg" alt="" width="28" height="21"><div class="scan-ev"><span class="scan-team">Event team</span><h1 class="scan-title">${ev.title}</h1></div><button type="button" class="btn btn-link scan-change" data-change>Change</button></div>
    ${Number(ev.is_test) === 1 ? html`<p class="tk-test mt" role="note" data-test-event>TEST EVENT · scans here are practice, not a real event</p>` : ""}${ev.age_restriction ? html`<p class="callout warn small mb-0 mt" data-age>Age rule: ${ageRule(ev.age_restriction)}</p>` : ""}
    ${tools.length > 1 ? html`<div class="tabs mt" role="tablist">${tools}</div>` : ""}
    <div class="scan-counts" aria-live="polite"><span id="stats" class="small"></span><span class="netbar on" id="net">Online</span></div>
    <p class="small muted mb-0" id="offline-state" aria-live="polite"></p>
    <div class="row mt scan-actions"><button type="button" class="btn btn-primary grow scan-go" data-cam>${svgIcon("scan", 26)}<span>Scan</span></button>${nfcSupported() ? html`<button type="button" class="btn btn-ghost grow" data-nfc>Tap NFC</button>` : ""}</div>
    <form class="scan-type mt" id="manual"><label for="mc">Type a code</label><input id="mc" class="grow mono" placeholder="Ticket or tag code" autocomplete="off" autocapitalize="characters" enterkeyhint="go"><button class="btn btn-ghost btn-sm">Check</button></form>
    <div id="desk"></div>
    <div class="verdict idle" id="verdict" role="status" aria-live="assertive"><div class="big">READY</div><div>Point the camera at a ticket QR code</div></div>
    <h2 class="mt-lg">Recent</h2><div id="recent"></div>
    <div class="scan-cam" id="scan-cam" hidden role="dialog" aria-modal="true" aria-label="Camera">
      <div class="scan-cam-bar"><span class="scan-cam-count" data-cam-count></span><button type="button" class="btn btn-ghost btn-sm" data-cam-close>Done</button></div>
      <div class="camera" id="cam"></div>
      <p class="scan-cam-hint">Hold the ticket's QR code inside the frame</p>
    </div>
    <div class="scan-flash" id="scan-flash" hidden aria-hidden="true"></div>`);
  $("[data-change]").addEventListener("click", () => { closeCamera(); offline.stop(); localStorage.removeItem("tr_scan_event"); pickEvent(); });
  $("[data-cam]").addEventListener("click", openCamera);
  $("[data-cam-close]").addEventListener("click", closeCamera);
  $("#scan-flash").addEventListener("click", endFlash);
  $("[data-nfc]")?.addEventListener("click", async () => {
    nfcAbort?.abort(); nfcAbort = new AbortController();
    try { await readNfc((v) => handle(v, true), nfcAbort.signal); toast("Hold the tag to the back of the phone."); } catch (err) { toast(`NFC: ${err.message}`, "bad"); }
  });
  $("#manual").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#mc").value.trim(); if (v) handle(v); $("#mc").value = ""; });
  // The top-up and cash-out desk takes the whole screen; "Back to scanning" returns here.
  const leave = () => { closeCamera(); nfcAbort?.abort(); offline.stop(); document.body.classList.remove("scan-live"); };
  $("[data-topup]")?.addEventListener("click", () => { leave(); deskApp(main, ev.id, { onBack: () => start(ev), backLabel: "Back to scanning" }); });
  $("[data-boxoffice]")?.addEventListener("click", () => { leave(); boxOfficeApp(main, ev.id, { onBack: () => start(ev), backLabel: "Back to event tools" }); });
  $$("[data-mode]").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.mode; $$("[data-mode]").forEach((x) => x.setAttribute("aria-selected", String(x === b))); deskTicket = null; drawDesk(); idle(); }));
  if (mode === "desk") { drawDesk(); idle(); }
  if (ev.can_scan) { offline.start(ev, drawOffline); refresh(true); }
}

// The camera fills the screen with a frame to aim at. After each scan the
// result flashes over it, then it is ready for the next person.
async function openCamera() {
  const sheet = $("#scan-cam");
  if (!sheet) return;
  sheet.hidden = false;
  document.documentElement.classList.add("scan-cam-open");
  drawStats();
  cam?.stop();
  cam = new Camera($("#cam"), (v) => { if (!flashing) handle(v); });
  try { await cam.start(); } catch { closeCamera(); toast("Camera unavailable. Allow camera access or type the code.", "bad"); }
}
function closeCamera() {
  cam?.stop(); cam = null;
  const sheet = $("#scan-cam");
  if (sheet) sheet.hidden = true;
  document.documentElement.classList.remove("scan-cam-open");
}
let flashing = false, flashTimer = 0;
const FLASH_MS = 1500;
function flash(kind, big, sub) {
  const f = $("#scan-flash");
  if (!f) return;
  render(f, html`<div class="flash-card"><div class="big">${big}</div>${sub ? html`<div class="flash-sub">${sub}</div>` : ""}</div>`);
  f.className = `scan-flash ${kind}`;
  f.hidden = false;
  flashing = true;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(endFlash, FLASH_MS);
}
function endFlash() {
  clearTimeout(flashTimer);
  flashing = false;
  const f = $("#scan-flash");
  if (f) f.hidden = true;
}
// The gate's answer: on the page, and as a full-screen flash.
function result(kind, big, sub = "") { verdict(kind, big, sub); flash(kind, big, sub); }

function drawOffline() {
  const el = $("#offline-state");
  if (!el) return;
  const s = offline.status();
  if (!s.available) { el.textContent = ""; return; }
  const parts = [s.ready ? `Offline ready: ${plural(s.count, "ticket")}, updated ${fmtClock(s.updatedAt)}` : "Downloading the ticket list for offline scanning…"];
  if (s.pending) parts.push(`${s.pending} offline scan${s.pending === 1 ? "" : "s"} waiting to send`);
  if (offline.doubleEntries()) parts.push(`${offline.doubleEntries()} offline scan${offline.doubleEntries() === 1 ? " was" : "s were"} already used at another gate`);
  el.textContent = parts.join(" · ");
}
const fmtClock = (iso) => (iso ? fmtTime(iso) : ""); // South African time, whatever the phone is set to

function idle() { verdict("idle", mode === "gate" ? "READY" : deskTicket ? "SCAN TAG" : "SCAN TICKET", mode === "gate" ? "Point the camera at a ticket QR code" : deskTicket ? "Now scan or tap the wristband / card / QR tag" : "Scan the attendee's ticket QR first"); }
function verdict(kind, big, sub = "") { const v = $("#verdict"); v.className = `verdict ${kind}`; render(v, html`<div class="big">${big}</div>${sub ? html`<div>${sub}</div>` : ""}`); }

function drawDesk() {
  render($("#desk"), mode === "desk" ? html`<div class="card mt"><div class="row between"><strong>Registration desk</strong>${deskTicket ? html`<button class="btn btn-link" data-reset>Start over</button>` : ""}</div>
    <p class="small muted mb-0">1. Scan the attendee's ticket. 2. Scan or tap the tag. The tag is linked to that attendee and ticket.</p>
    ${deskTicket ? html`<p class="small mt mb-0">Ticket scanned</p>` : ""}</div>` : "");
  $("[data-reset]")?.addEventListener("click", () => { deskTicket = null; drawDesk(); idle(); });
}

const isTicket = (v) => /^T[RP]1\./.test(v) || /^[2-9A-HJ-NP-TV-Z]{10}$/i.test(v.replace(/[\s-]/g, ""));

async function handle(value, fromNfc = false) {
  if (mode === "desk") return desk(value, fromNfc);
  const body = { eventId: EVENT.id, gate: localStorage.getItem("tr_gate") || undefined };
  if (!fromNfc && isTicket(value)) body.payload = value; else body.tagInput = value;
  try {
    const r = await post("/api/staff/scan", body, { timeoutMs: 6000 });
    show(r);
    countScan(r);
    if (r.outcome === "admitted" && body.payload) offline.markUsed(body.payload).catch(() => {});
    setNet(true);
  } catch (err) {
    if (!unreachable(err)) { result("no", "ERROR", err.message); beep(false); }
    else {
      setNet(false);
      const r = body.payload ? await offline.check(body.payload, body.gate).catch(() => null) : null;
      if (r) show(r);
      else { result("warn", "NO CONNECTION", body.payload ? "This ticket was NOT checked. Do not admit until it scans green." : "Tags can't be checked offline. Scan the ticket QR code."); beep(false); }
    }
  }
  refresh();
}

function show(r) {
  const [kind, word] = VERDICT[r.outcome] || ["no", r.outcome];
  // A couple or table ticket lets several people in: say so in big letters.
  const big = r.outcome === "admitted" && r.admits > 1 ? `ADMIT ${r.admits}` : r.outcome === "admitted" && r.pass ? "PASS OK" : word;
  result(kind, r.offline ? `${big} (OFFLINE)` : big, [r.testEvent ? "TEST EVENT" : "", r.holderName, r.ticketType, r.outcome === "already_used" && r.admittedAt ? `first scanned at ${fmtTime(r.admittedAt)}` : r.outcome !== "admitted" ? r.message : "",
    ["admitted", "already_used"].includes(r.outcome) ? ageRule(r.ageRestriction) : ""].filter(Boolean).join(" · "));
  beep(r.outcome === "admitted");
}

async function desk(value, fromNfc) {
  if (!deskTicket) {
    if (!isTicket(value) || fromNfc) return verdict("warn", "SCAN TICKET FIRST", "Scan the attendee's ticket QR before the tag.");
    deskTicket = value; drawDesk(); beep(true); return idle();
  }
  try {
    const r = await post("/api/staff/tags/link", { eventId: EVENT.id, ticketPayload: deskTicket, tagInput: value });
    verdict("ok", "TAG LINKED", r.holderName || ""); beep(true);
  } catch (err) { verdict("no", "NOT LINKED", err.message); beep(false); }
  deskTicket = null; drawDesk();
}

function setNet(on) {
  const n = $("#net");
  if (!n) return;
  n.className = `netbar ${on ? "on" : "off"}`;
  n.textContent = on ? "Online" : offline.status().ready ? "Offline: checking against this phone's list" : "Offline: scans cannot be checked";
  if (on) offline.sync();
}

// Totals are shared by every gate, so ask at most every 4 seconds, not after
// every single scan.
let lastRefresh = 0, refreshTimer = null, STATS = null;
function refresh(now = false) {
  const wait = now ? 0 : Math.max(0, lastRefresh + 4000 - Date.now());
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; lastRefresh = Date.now(); loadStats(); }, wait);
}
setInterval(() => EVENT && refresh(), 15000);

async function loadStats() {
  if (!EVENT) return;
  try {
    STATS = await get(`/api/staff/events/${EVENT.id}/stats`);
    setNet(true);
    drawStats();
  } catch (err) { if (unreachable(err)) setNet(false); }
}
function drawStats() {
  const s = STATS;
  if (!s || !$("#stats")) return;
  $("#stats").textContent = `${s.admitted.toLocaleString("en-ZA")} of ${plural(s.issued, "ticket")} scanned in · ${s.mine.toLocaleString("en-ZA")} by you`;
  const c = $("[data-cam-count]");
  if (c) c.textContent = `${s.admitted.toLocaleString("en-ZA")} of ${s.issued.toLocaleString("en-ZA")} in`;
  render($("#recent"), s.recent.length ? html`<div class="table-wrap"><table><tbody>${s.recent.map((x) => html`<tr><td>${fmtTime(x.occurred_at)}</td><td>${(VERDICT[x.outcome] || [, x.outcome])[1]}</td><td>${x.holder_name || ""}</td></tr>`)}</tbody></table></div>` : html`<p class="muted small">No scans yet.</p>`);
}
// Show this scan in the counts and the Recent list straight away; the next
// refresh from the server replaces it with the full picture.
function countScan(r) {
  if (!STATS) return;
  if (r.outcome === "admitted") { const n = r.pass ? 0 : (r.admits || 1); STATS.admitted += n; STATS.mine += n; }
  STATS.recent = [{ occurred_at: new Date().toISOString(), outcome: r.outcome, holder_name: r.holderName || "" }, ...(STATS.recent || [])].slice(0, 10);
  drawStats();
}

window.addEventListener("offline", () => setNet(false));
// Signed out (or signed in as someone else) in another tab: stop the camera and the list refresh.
window.addEventListener("tr:session-changed", () => { closeCamera(); endFlash(); document.body.classList.remove("scan-live"); nfcAbort?.abort(); offline.stop(); EVENT = null; });
window.addEventListener("online", () => setNet(true));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

(async () => {
  // Reopened with no signal at all: carry on with the list saved on this phone.
  const saved = localStorage.getItem("tr_scan_event");
  const reachable = navigator.onLine !== false && await fetch("/api/health", { cache: "no-store" }).then((r) => r.text()).then(() => true, () => false);
  if (!reachable && saved) {
    const ev = await offline.savedEvent(saved);
    // Only someone who scans at this event has its ticket list on the phone.
    if (ev) { render($("#header"), html`<div class="wrap"><span class="wordmark">TICKET<b>ROOM</b></span></div>`); start({ ...ev, can_scan: 1 }); return setNet(false); }
  }
  await header($("#header"), { portal: "scanner" });
  // A scanner's "set your password" link opens here.
  if (emailLinkPage("scanner")) return;
  const u = await requireUser("Gate staff: sign in to scan tickets.", "scanner");
  if (!u) return render(main, empty("Sign in to scan."));
  // TicketRoom staff use the scanner only for a test event, opened from the admin portal.
  if (accountType(u) === "staff" && !TEST_EVENT) return wrongAccountPage(u, "scanner");
  await header($("#header"), { portal: "scanner" });
  render(main, spinner());
  // Pull down on the gate to load the counts again.
  pullToRefresh(() => !!EVENT && !!$("#stats"), async () => { lastRefresh = Date.now(); await loadStats(); });
  installPrompt();
  DESK = !!(await features()).cashDesk;
  pickEvent();
})();
