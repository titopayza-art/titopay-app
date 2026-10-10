// Offline scanning for big venues. Before the gates open the phone downloads
// the event's ticket list (code, QR version, status, first name, ticket type)
// and keeps it in IndexedDB. If the stadium's mobile data drops, tickets are
// checked against that list, each admission is remembered on the phone, and
// the scans are sent to the server as soon as the signal is back. The server
// re-checks every one, so a ticket let in at two gates while both were offline
// is reported, not lost.
import { get, post } from "/assets/core.js";

const DB = "ticketroom-scan";
const REFRESH_MS = 3 * 60 * 1000; // pick up new sales, transfers and other gates' scans
const SYNC_MS = 10 * 1000;

let idb = null;
let state = null; // { eventId, event, generatedAt, tickets: Map(code -> [version, status, name, type]) }
let queue = []; // [{ id, payload, gate, at }]
let available = true; // false on servers without offline support
let onChange = () => {};
let timers = [];

function open() {
  if (idb) return Promise.resolve(idb);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => { idb = r.result; resolve(idb); };
    r.onerror = () => reject(r.error);
  });
}
async function kv(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode);
    const req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const load = (key) => kv("readonly", (s) => s.get(key)).catch(() => undefined);
const save = (key, value) => kv("readwrite", (s) => s.put(value, key)).catch(() => {});
const remove = (key) => kv("readwrite", (s) => s.delete(key)).catch(() => {});

let saveTimer = null;
function savePackSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => state && save(`pack:${state.eventId}`, { event: state.event, generatedAt: state.generatedAt, tickets: [...state.tickets] }), 1500);
}
const saveQueue = () => state && save(`queue:${state.eventId}`, queue);

export function status() {
  if (!available) return { available: false };
  return { available: true, ready: !!state?.tickets.size, count: state?.tickets.size || 0, updatedAt: state?.generatedAt, pending: queue.length };
}

// The event saved on this phone, for reopening the scanner with no signal.
export async function savedEvent(eventId) {
  const p = await load(`pack:${eventId}`);
  return p?.event || null;
}

async function download(full) {
  const since = !full && state?.generatedAt ? `?since=${encodeURIComponent(state.generatedAt)}` : "";
  const r = await get(`/api/staff/events/${state.eventId}/offline-pack${since}`, { timeoutMs: 60000 });
  if (r.full) state.tickets = new Map();
  // Never forget a ticket this phone let in but has not synced yet.
  const pending = new Set(queue.map((s) => s.code));
  // A sixth field marks a re-entry gate pass: it stays valid after a scan.
  for (const [code, version, st, name, type, multi] of r.tickets) state.tickets.set(code, [version, pending.has(code) && !multi ? 2 : st, name, type, multi ? 1 : 0]);
  state.event = r.event;
  state.generatedAt = r.generatedAt;
  savePackSoon();
  onChange();
}

export async function start(event, changed) {
  stop();
  onChange = changed || (() => {});
  state = { eventId: event.id, event, generatedAt: null, tickets: new Map() };
  const saved = await load(`pack:${event.id}`);
  if (saved) { state.tickets = new Map(saved.tickets); state.generatedAt = saved.generatedAt; state.event = saved.event; }
  queue = (await load(`queue:${event.id}`)) || [];
  onChange();
  try { await download(!saved); available = true; } catch (err) { if (err.status === 404 || err.status === 501) available = false; }
  onChange();
  timers.push(setInterval(() => { if (available && navigator.onLine !== false) download(false).catch(() => {}); }, REFRESH_MS));
  timers.push(setInterval(() => sync(), SYNC_MS));
  sync();
}

export function stop() { timers.forEach(clearInterval); timers = []; state = null; queue = []; }

// Forget the stored list for every other event (personal information should
// not sit on staff phones longer than needed).
export async function forgetOthers(keepId) {
  const keys = await kv("readonly", (s) => s.getAllKeys()).catch(() => []);
  for (const k of keys || []) if (!String(k).endsWith(keepId)) remove(k);
}

function parse(value) {
  const s = String(value).trim();
  const m = /^T[RP]1\.([2-9A-HJ-NP-TV-Z]{10})\.(\d{1,6})\.[A-Za-z0-9_-]{22}$/.exec(s);
  if (m) return { code: m[1], version: Number(m[2]) };
  const typed = s.replace(/[\s-]/g, "").toUpperCase();
  return /^[2-9A-HJ-NP-TV-Z]{10}$/.test(typed) ? { code: typed, version: null } : null;
}

// A live scan was admitted by the server: remember it here too, so the same
// ticket is refused if the signal drops afterwards.
export function markUsed(value) {
  const p = parse(value);
  const t = p && state?.tickets.get(p.code);
  if (t && t[1] !== 2 && !t[4]) { t[1] = 2; savePackSoon(); }
}

// Check a ticket against the phone's copy of the list. Returns null when this
// phone has no list for the event.
export function check(value, gate) {
  if (!state?.tickets.size) return null;
  const ev = state.event;
  const now = Date.now();
  const p = parse(value);
  const t = p && state.tickets.get(p.code);
  // Same windows as the server: tickets from 12 hours before to 6 after,
  // gate passes from 2 days before (setup) to a day after (strike).
  const isPass = /^Gate pass/.test(t?.[3] || "");
  const [before, after] = isPass ? [48, 24] : [12, 6];
  if (ev && (now < Date.parse(ev.starts_at) - before * 3600e3 || now > Date.parse(ev.ends_at) + after * 3600e3)) {
    return { outcome: "event_not_live", message: "This event is not open for entry right now." };
  }
  if (!p) return { outcome: "invalid", message: "Not a TicketRoom ticket." };
  if (!t) return { outcome: "invalid", message: "Not on this event's ticket list." };
  const [version, st, name, type, multi] = t;
  if (p.version !== null && p.version !== version) return { outcome: "invalid", message: "This QR code was replaced. Ask for the current ticket.", holderName: name };
  if (st === 2) return { outcome: "already_used", message: "Already scanned.", holderName: name, ticketType: type };
  if (st !== 1) return { outcome: "invalid", message: "This ticket is no longer valid.", holderName: name, ticketType: type };
  if (!multi) t[1] = 2;
  queue.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, code: p.code, payload: String(value).trim(), gate: gate || undefined, at: new Date().toISOString() });
  saveQueue();
  savePackSoon();
  onChange();
  const admits = Number(/Admit (\d+)/.exec(type || "")?.[1] || 1);
  return { outcome: "admitted", offline: true, holderName: name, ticketType: type, admits, pass: isPass };
}

let syncing = false;
let doubles = 0;
export const doubleEntries = () => doubles;

export async function sync() {
  if (syncing || !state || !queue.length || navigator.onLine === false) return;
  syncing = true;
  const eventId = state.eventId;
  try {
    while (queue.length && state?.eventId === eventId) {
      const batch = queue.slice(0, 200);
      const r = await post("/api/staff/scan/sync", { eventId, scans: batch.map(({ id, payload, gate, at }) => ({ id, payload, gate, at })) }, { timeoutMs: 30000 });
      for (const x of r.results) if (x.outcome === "already_used") doubles++;
      const done = new Set(batch.map((s) => s.id));
      queue = queue.filter((s) => !done.has(s.id));
      saveQueue();
      onChange();
    }
  } catch { /* still offline; try again shortly */ }
  syncing = false;
}
