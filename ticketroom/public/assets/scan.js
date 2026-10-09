// Gate scanner and registration (tag) desk for event staff.
import { html, render, $, $$, get, post, header, requireUser, toast, fmtTime, empty, spinner } from "/assets/core.js";
import { Camera, readNfc, nfcSupported, beep } from "/assets/reader.js";

const main = $("#main");
let EVENT = null, cam = null, nfcAbort = null, mode = "gate", deskTicket = null;

const VERDICT = {
  admitted: ["ok", "ADMIT"], already_used: ["no", "ALREADY SCANNED"], invalid: ["no", "NOT VALID"], wrong_event: ["warn", "WRONG EVENT"],
  revoked: ["no", "REVOKED"], refunded: ["no", "REFUNDED"], event_not_live: ["warn", "NOT OPEN"], offline: ["warn", "NO CONNECTION"],
};

async function pickEvent() {
  const { events } = await get("/api/staff/events");
  if (!events.length) return render(main, html`<div class="card">${empty("You aren't assigned to any live events. Ask the organiser to add you as staff.")}</div>`);
  const saved = localStorage.getItem("tr_scan_event");
  const found = events.find((e) => e.id === saved);
  if (found && events.length === 1) return start(found);
  render(main, html`<h1>Choose event</h1><div class="stack">${events.map((e) => html`<button class="card btn-block row between" data-ev="${e.id}"><span><strong>${e.title}</strong><br><span class="small muted">${e.venue_name} · ${fmtTime(e.starts_at)}</span></span><span>→</span></button>`)}</div>`);
  $$("[data-ev]").forEach((b) => b.addEventListener("click", () => { const ev = events.find((e) => e.id === b.dataset.ev); localStorage.setItem("tr_scan_event", ev.id); start(ev); }));
}

function start(ev) {
  EVENT = ev;
  render(main, html`<div class="row between"><div><div class="small muted">Scanning for</div><h1 class="mb-0">${ev.title}</h1></div><button class="btn btn-ghost btn-sm" data-change>Change</button></div>
    <div class="tabs mt" role="tablist"><button role="tab" aria-selected="true" data-mode="gate">Gate</button>${ev.can_manage_tags ? html`<button role="tab" aria-selected="false" data-mode="desk">Tag desk</button>` : ""}</div>
    <div class="row between"><span id="stats" class="small muted"></span><span class="netbar on" id="net">● Online</span></div>
    <div class="camera mt" id="cam"></div>
    <div class="row mt"><button class="btn btn-primary grow" data-cam>Start camera</button>${nfcSupported() ? html`<button class="btn btn-ghost grow" data-nfc>Tap NFC</button>` : ""}</div>
    <form class="row mt" id="manual"><label class="sr-only" for="mc">Ticket or tag code</label><input id="mc" class="grow mono" placeholder="Type ticket code" autocomplete="off" autocapitalize="characters"><button class="btn btn-ghost">Check</button></form>
    <div id="desk"></div>
    <div class="verdict idle" id="verdict" role="status" aria-live="assertive"><div class="big">READY</div><div>Point the camera at a ticket QR code</div></div>
    <h2 class="mt-lg">Recent</h2><div id="recent"></div>`);
  $("[data-change]").addEventListener("click", () => { cam?.stop(); localStorage.removeItem("tr_scan_event"); pickEvent(); });
  $("[data-cam]").addEventListener("click", async (e) => {
    if (cam?.running) { cam.stop(); e.target.textContent = "Start camera"; return; }
    cam = new Camera($("#cam"), handle);
    try { await cam.start(); e.target.textContent = "Stop camera"; } catch { toast("Camera unavailable. Allow camera access or type the code.", "bad"); }
  });
  $("[data-nfc]")?.addEventListener("click", async () => {
    nfcAbort?.abort(); nfcAbort = new AbortController();
    try { await readNfc((v) => handle(v, true), nfcAbort.signal); toast("Hold the tag to the back of the phone."); } catch (err) { toast(`NFC: ${err.message}`, "bad"); }
  });
  $("#manual").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#mc").value.trim(); if (v) handle(v); $("#mc").value = ""; });
  $$("[data-mode]").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.mode; $$("[data-mode]").forEach((x) => x.setAttribute("aria-selected", String(x === b))); deskTicket = null; drawDesk(); idle(); }));
  refresh();
}

function idle() { verdict("idle", mode === "gate" ? "READY" : deskTicket ? "SCAN TAG" : "SCAN TICKET", mode === "gate" ? "Point the camera at a ticket QR code" : deskTicket ? "Now scan or tap the wristband / card / QR tag" : "Scan the attendee's ticket QR first"); }
function verdict(kind, big, sub = "") { const v = $("#verdict"); v.className = `verdict ${kind}`; render(v, html`<div class="big">${big}</div>${sub ? html`<div>${sub}</div>` : ""}`); }

function drawDesk() {
  render($("#desk"), mode === "desk" ? html`<div class="card mt"><div class="row between"><strong>Registration desk</strong>${deskTicket ? html`<button class="btn btn-link" data-reset>Start over</button>` : ""}</div>
    <p class="small muted mb-0">1. Scan the attendee's ticket. 2. Scan or tap the tag. The tag is linked to that attendee and ticket.</p>
    ${deskTicket ? html`<p class="small mt mb-0">Ticket scanned</p>` : ""}</div>` : "");
  $("[data-reset]")?.addEventListener("click", () => { deskTicket = null; drawDesk(); idle(); });
}

const isTicket = (v) => /^TR1\./.test(v) || /^[2-9A-HJ-NP-TV-Z]{10}$/i.test(v.replace(/[\s-]/g, ""));

async function handle(value, fromNfc = false) {
  if (mode === "desk") return desk(value, fromNfc);
  const body = { eventId: EVENT.id, gate: localStorage.getItem("tr_gate") || undefined };
  if (!fromNfc && isTicket(value)) body.payload = value; else body.tagInput = value;
  try {
    const r = await post("/api/staff/scan", body, { timeoutMs: 8000 });
    const [kind, big] = VERDICT[r.outcome] || ["no", r.outcome];
    verdict(kind, big, [r.holderName, r.ticketType, r.outcome === "already_used" && r.admittedAt ? `first scanned at ${fmtTime(r.admittedAt)}` : r.outcome !== "admitted" ? r.message : ""].filter(Boolean).join(" · "));
    beep(r.outcome === "admitted");
    setNet(true);
  } catch (err) {
    if (err.status === 0) { verdict("warn", "NO CONNECTION", "This ticket was NOT checked. Do not admit until it scans green."); setNet(false); beep(false); }
    else { verdict("no", "ERROR", err.message); beep(false); }
  }
  refresh();
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

function setNet(on) { const n = $("#net"); if (!n) return; n.className = `netbar ${on ? "on" : "off"}`; n.textContent = on ? "● Online" : "● Offline — scans cannot be verified"; }

async function refresh() {
  try {
    const s = await get(`/api/staff/events/${EVENT.id}/stats`);
    $("#stats").textContent = `${s.admitted} of ${s.issued} in · you: ${s.mine}`;
    render($("#recent"), s.recent.length ? html`<div class="table-wrap"><table><tbody>${s.recent.map((x) => html`<tr><td>${fmtTime(x.occurred_at)}</td><td>${(VERDICT[x.outcome] || [, x.outcome])[1]}</td><td>${x.holder_name || ""}</td></tr>`)}</tbody></table></div>` : html`<p class="muted small">No scans yet.</p>`);
  } catch { setNet(false); }
}

window.addEventListener("offline", () => setNet(false));
window.addEventListener("online", () => setNet(true));

(async () => {
  await header($("#header"), { portal: "Scanner", links: [["/scan", "Scanner"]] });
  const u = await requireUser("Staff sign in to scan tickets.");
  if (!u) return render(main, empty("Sign in to scan."));
  await header($("#header"), { portal: "Scanner", links: [["/scan", "Scanner"]] });
  render(main, spinner());
  pickEvent();
})();
