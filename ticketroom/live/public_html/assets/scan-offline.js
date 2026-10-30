// Offline scanning for big venues. Before the gates open the phone downloads
// the event's ticket list (QR version, status, first name, ticket type) and
// keeps it in IndexedDB. If the stadium's mobile data drops, tickets are
// checked against that list, each admission is remembered on the phone, and
// the scans are sent to the server as soon as the signal is back. The server
// re-checks every one, so a ticket let in at two gates while both were offline
// is reported, not lost.
//
// The list holds no ticket codes: each entry is found by a keyed hash of the
// code, and a QR code is only taken if the hash of its signature matches too.
// A copy of the list gives nobody codes to type in or QR codes to print.
import { get, post, me } from "/assets/core.js";

const DB = "ticketroom-scan";
const FORMAT = 2; // lists saved by older versions held codes in clear: they are dropped
const REFRESH_MS = 3 * 60 * 1000; // pick up new sales, transfers and other gates' scans
const SYNC_MS = 10 * 1000;
const RETAIN_AFTER_EVENT_MS = 24 * 60 * 60 * 1000;
const TZ = "Africa/Johannesburg";

let idb = null;
// { eventId, event, key, generatedAt, tickets: Map(codeHash -> [sigHash, version, status, name, type, multi, lastDay]) }
let state = null;
let queue = []; // [{ id, k, payload, gate, at, by }] (by: who scanned, so a scan sent after a change of person stays theirs)
let available = true; // false on servers without offline support
let onChange = () => {};
let timers = [];
let hmacKey = null;

function open() {
  if (idb) return Promise.resolve(idb);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => { idb = r.result; idb.onversionchange = () => { idb.close(); idb = null; }; resolve(idb); };
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

// The same keyed hash the server puts in the list (HMAC-SHA256, hex, cut short).
async function useKey(key) {
  hmacKey = key ? await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]) : null;
}
async function hash(s, len = 20) {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(s)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}
// Today's date at the venue, for passes that let their holder in once a day.
const today = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

let saveTimer = null;
function savePackSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => state && save(`pack:${state.eventId}`, { format: FORMAT, event: state.event, key: state.key, generatedAt: state.generatedAt, tickets: [...state.tickets] }), 1500);
}
const saveQueue = () => state && save(`queue:${state.eventId}`, queue);

export function status() {
  if (!available) return { available: false };
  return { available: true, ready: !!state?.tickets.size, count: state?.tickets.size || 0, updatedAt: state?.generatedAt, pending: queue.length };
}

// The event saved on this phone, for reopening the scanner with no signal.
export async function savedEvent(eventId) {
  const p = await load(`pack:${eventId}`);
  return p?.format === FORMAT ? p.event : null;
}

async function download(full) {
  const since = !full && state?.generatedAt ? `?since=${encodeURIComponent(state.generatedAt)}` : "";
  const r = await get(`/api/staff/events/${state.eventId}/offline-pack${since}`, { timeoutMs: 60000 });
  if (r.format !== FORMAT) { available = false; return; }
  if (r.full || r.key !== state.key) state.tickets = new Map();
  if (r.key !== state.key) { state.key = r.key; await useKey(r.key); }
  // Never forget a ticket this phone let in but has not synced yet.
  const pending = new Set(queue.map((s) => s.k).filter(Boolean));
  for (const [k, sig, version, st, name, type, multi, lastDay] of r.tickets) {
    const mine = pending.has(k);
    state.tickets.set(k, [sig, version, mine && !multi ? 2 : st, name, type, multi || 0, mine && multi === 2 ? today() : lastDay]);
  }
  state.event = r.event;
  state.generatedAt = r.generatedAt;
  savePackSoon();
  onChange();
}

export async function start(event, changed) {
  stop();
  onChange = changed || (() => {});
  state = { eventId: event.id, event, key: null, generatedAt: null, tickets: new Map() };
  let saved = await load(`pack:${event.id}`);
  if (saved && saved.format !== FORMAT) { await remove(`pack:${event.id}`); saved = null; }
  // Ticket lists contain attendee data. A scanner must never quietly retain an
  // old event forever when a phone is reused or lost after the event.
  if (saved?.event?.ends_at && Date.parse(saved.event.ends_at) + RETAIN_AFTER_EVENT_MS < Date.now()) {
    await remove(`pack:${event.id}`); saved = null;
  }
  if (saved) { state.tickets = new Map(saved.tickets); state.generatedAt = saved.generatedAt; state.event = saved.event; state.key = saved.key; await useKey(saved.key); }
  queue = (await load(`queue:${event.id}`)) || [];
  onChange();
  available = true;
  try { await download(!saved); } catch (err) { if (err.status === 404 || err.status === 501) available = false; }
  onChange();
  timers.push(setInterval(() => { if (available && navigator.onLine !== false) download(false).catch(() => {}); }, REFRESH_MS));
  timers.push(setInterval(() => { sync(); syncOthers(); }, SYNC_MS));
  sync();
  syncOthers();
}

export function stop() { timers.forEach(clearInterval); timers = []; state = null; queue = []; hmacKey = null; }

// Forget the stored list for every other event (personal information should
// not sit on staff phones longer than needed). Scans made offline at another
// event and not sent yet are kept until they reach the server.
export async function forgetOthers(keepId) {
  const keys = await kv("readonly", (s) => s.getAllKeys()).catch(() => []);
  for (const k of keys || []) {
    const [kind, id] = String(k).split(":");
    if (id === keepId) continue;
    if (kind === "queue" && ((await load(k)) || []).length) continue;
    remove(k);
  }
}

// Offline scans from another event this phone was used at: send them too.
let syncingOthers = false;
export async function syncOthers() {
  if (syncingOthers || navigator.onLine === false) return;
  syncingOthers = true;
  try {
    const keys = await kv("readonly", (s) => s.getAllKeys()).catch(() => []);
    for (const k of keys || []) {
      const [kind, eventId] = String(k).split(":");
      if (kind !== "queue" || !eventId || eventId === state?.eventId) continue;
      let left = (await load(k)) || [];
      while (left.length) {
        const batch = left.slice(0, 200);
        const r = await post("/api/staff/scan/sync", { eventId, scans: batch.map(({ id, payload, gate, at, by }) => ({ id, payload, gate, at, by })) }, { timeoutMs: 30000 });
        for (const x of r.results) if (x.outcome === "already_used") doubles++;
        const done = new Set(batch.map((s) => s.id));
        left = left.filter((s) => !done.has(s.id));
        await save(k, left);
      }
      await remove(k);
      onChange();
    }
  } catch { /* still offline, or no longer on that event's team: try again later */ }
  syncingOthers = false;
}

function parse(value) {
  const s = String(value).trim();
  const m = /^T[RP]1\.([2-9A-HJ-NP-TV-Z]{10})\.(\d{1,6})\.([A-Za-z0-9_-]{22})$/.exec(s);
  if (m) return { code: m[1], version: Number(m[2]), sig: m[3] };
  const typed = s.replace(/[\s-]/g, "").toUpperCase();
  return /^[2-9A-HJ-NP-TV-Z]{10}$/.test(typed) ? { code: typed, version: null, sig: null } : null;
}
async function find(value) {
  const p = parse(value);
  if (!p || !hmacKey) return { p };
  const k = await hash(`c|${p.code}`);
  return { p, k, t: state?.tickets.get(k) };
}

// A live scan was admitted by the server: remember it here too, so the same
// ticket is refused if the signal drops afterwards.
export async function markUsed(value) {
  const { t } = await find(value).catch(() => ({}));
  if (!t) return;
  if (t[5] === 2) { t[6] = today(); savePackSoon(); }
  else if (t[2] !== 2 && !t[5]) { t[2] = 2; savePackSoon(); }
}

// Check a ticket against the phone's copy of the list. Returns null when this
// phone has no list for the event.
export async function check(value, gate) {
  if (!state?.tickets.size || !hmacKey) return null;
  const ev = state.event;
  const now = Date.now();
  const { p, k, t } = await find(value);
  // Same windows as the server: tickets from 12 hours before to 6 after,
  // gate passes from 2 days before (setup) to a day after (strike).
  const isPass = /^Gate pass/.test(t?.[4] || "");
  const [before, after] = isPass ? [48, 24] : [12, 6];
  if (ev && (now < Date.parse(ev.starts_at) - before * 3600e3 || now > Date.parse(ev.ends_at) + after * 3600e3)) {
    return { outcome: "event_not_live", message: "This event is not open for entry right now." };
  }
  if (!p) return { outcome: "invalid", message: "Not a TicketRoom ticket." };
  if (!t) return { outcome: "invalid", message: "Not on this event's ticket list." };
  const [sig, version, st, name, type, multi, lastDay] = t;
  const age = ev?.age_restriction || undefined;
  if (type === "Replaced") return { outcome: "replaced", message: "This code was replaced (ticket transferred or reissued). Ask for the current ticket." };
  // A QR code must carry the signature the server made for this ticket.
  if (p.sig !== null && (p.version !== version || (await hash(`s|${p.sig}`, 12)) !== sig)) return { outcome: "replaced", message: "This QR code was replaced. Ask for the current ticket.", holderName: name };
  if (st === 0 && type === "Resold") return { outcome: "resold", message: "This ticket was resold on TicketRoom Exchange. The new owner has a new code.", holderName: name };
  if (st === 0 && type === "Refund in progress") return { outcome: "refund_pending", message: "Refund in progress. Not valid for entry.", holderName: name };
  if (st === 2) return { outcome: "already_used", message: "Already scanned.", holderName: name, ticketType: type, ageRestriction: age };
  if (st !== 1) return { outcome: "invalid", message: "This ticket is no longer valid.", holderName: name, ticketType: type };
  if (multi === 2 && lastDay === today()) return { outcome: "already_used", message: "Already scanned today.", holderName: name, ticketType: type, ageRestriction: age };
  if (multi === 2) t[6] = today();
  else if (!multi) t[2] = 2;
  const by = (await me().catch(() => null))?.id || undefined;
  queue.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, k, payload: String(value).trim(), gate: gate || undefined, at: new Date().toISOString(), by });
  saveQueue();
  savePackSoon();
  onChange();
  const admits = Number(/Admit (\d+)/.exec(type || "")?.[1] || 1);
  return { outcome: "admitted", offline: true, holderName: name, ticketType: multi === 2 ? `${type} · Today only` : type, admits, pass: isPass, ageRestriction: age };
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
      const r = await post("/api/staff/scan/sync", { eventId, scans: batch.map(({ id, payload, gate, at, by }) => ({ id, payload, gate, at, by })) }, { timeoutMs: 30000 });
      for (const x of r.results) if (x.outcome === "already_used") doubles++;
      const done = new Set(batch.map((s) => s.id));
      queue = queue.filter((s) => !done.has(s.id));
      saveQueue();
      onChange();
    }
  } catch { /* still offline; try again shortly */ }
  syncing = false;
}
