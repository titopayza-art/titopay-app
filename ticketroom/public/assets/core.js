// TicketRoom shared client. Every dynamic value that reaches innerHTML goes
// through esc() / html``. No inline handlers or styles (CSP forbids them).

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const RAW = Symbol("raw");
export const raw = (s) => ({ [RAW]: String(s) });
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x && x[RAW] !== undefined ? x[RAW] : esc(x))).join("") : v && v[RAW] !== undefined ? v[RAW] : esc(v);
    out += part + strings[i + 1];
  });
  return raw(out);
}
export const render = (el, tpl) => { el.innerHTML = tpl && tpl[RAW] !== undefined ? tpl[RAW] : esc(tpl); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- formatting (South Africa) ----------
const TZ = "Africa/Johannesburg";
export function money(cents) {
  const n = Number(cents || 0);
  const abs = Math.abs(n);
  const r = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${n < 0 ? "−" : ""}R${r}${abs % 100 ? "." + String(abs % 100).padStart(2, "0") : ""}`;
}
export const moneyExact = (c) => { const n = Number(c || 0), a = Math.abs(n); return `${n < 0 ? "−" : ""}R${Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${String(a % 100).padStart(2, "0")}`; };
export const fmtDate = (d, o = { weekday: "short", day: "numeric", month: "short", year: "numeric" }) => d ? new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, ...o }).format(new Date(d)) : "";
export const fmtTime = (d) => d ? new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d)) : "";
export const fmtDateTime = (d) => d ? `${fmtDate(d)} · ${fmtTime(d)}` : "";
export const dayNum = (d) => new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, day: "numeric" }).format(new Date(d));
export const monShort = (d) => new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, month: "short" }).format(new Date(d));
export const toLocalInput = (d) => { if (!d) return ""; const x = new Date(d); const p = (n) => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`; };
export const parseRand = (s) => { const t = String(s || "").replace(/^R\s*/i, "").replace(/\s/g, "").replace(",", "."); if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null; const [w, f = ""] = t.split("."); return Number(w) * 100 + Number((f + "00").slice(0, 2)); };
export const idem = () => (crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);
export const initials = (name) => String(name || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

// ---------- edition features ----------
// The PHP edition (shared hosting) has no payments, cashless, POS or SMS yet;
// /api/config says so and feature-specific UI marked data-feature="…" hides.
const ALL_FEATURES = { payments: true, cashless: true, pos: true, finance: true, sms: true, tags: true };
let featurePromise;
export function features() {
  featurePromise ||= fetch("/api/config", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
    .then((c) => ({ ...ALL_FEATURES, ...(c.features || {}) }));
  return featurePromise;
}
features().then((f) => { for (const [k, on] of Object.entries(f)) document.documentElement.classList.toggle(`no-${k}`, !on); });

// Wraps a portal route so it shows a friendly "coming soon" page when the
// feature is off in this edition (e.g. someone opens an old link).
const SOON = {
  cashless: ["Cashless wristbands are coming soon", "Wristbands, top-ups and tapping to pay at events arrive together with paid ticket sales."],
  payments: ["Payment methods are coming soon", "You'll be able to save a payment method here once paid ticket sales open."],
  finance: ["Payouts and refunds are coming soon", "Free events don't involve any money. Payouts, settlements and refunds start when paid ticket sales open."],
  tags: ["Wristbands and tags are coming soon", "Linking wristbands and tags to tickets arrives together with cashless payments."],
  pos: ["Vendor point of sale is coming soon", "The vendor till arrives together with cashless payments and paid ticket sales."],
};
export function gate(feature, fn) {
  return async (params) => {
    if ((await features())[feature]) return fn(params);
    const [title, text] = SOON[feature] || ["Coming soon", "This part of TicketRoom isn't switched on yet."];
    render($("#main"), html`<div class="card pad-lg stack"><h1>${title}</h1><p class="muted mb-0">${text}</p></div>`);
  };
}

// ---------- API ----------
let csrfToken = null;
let meCache;
export class ApiError extends Error { constructor(status, body) { super(body?.error?.message || `Request failed (${status})`); this.status = status; this.code = body?.error?.code; this.details = body?.error?.details; } }

export async function api(method, path, body, { headers = {}, timeoutMs = 20000, raw: rawBody } = {}) {
  const opts = { method, headers: { ...headers }, credentials: "same-origin" };
  if (body !== undefined && !rawBody) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  if (rawBody) { opts.body = rawBody; }
  if (method !== "GET") {
    if (!csrfToken) await me();
    if (csrfToken) opts.headers["x-csrf-token"] = csrfToken;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  opts.signal = ctl.signal;
  let res;
  try { res = await fetch(path, opts); } catch (err) {
    const e = new ApiError(0, { error: { code: err.name === "AbortError" ? "timeout" : "network", message: err.name === "AbortError" ? "The server did not answer in time." : "You appear to be offline." } });
    throw e;
  } finally { clearTimeout(timer); }
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 403 && data?.error?.code === "csrf_failed") { meCache = undefined; csrfToken = null; }
    throw new ApiError(res.status, data);
  }
  return data;
}
export const get = (p, o) => api("GET", p, undefined, o);
export const post = (p, b = {}, o) => api("POST", p, b, o);
export const patch = (p, b = {}, o) => api("PATCH", p, b, o);
export const put = (p, b = {}, o) => api("PUT", p, b, o);
export const del = (p, o) => api("DELETE", p, undefined, o);

export async function me(force = false) {
  if (meCache !== undefined && !force) return meCache;
  try {
    const r = await fetch("/api/auth/me", { credentials: "same-origin" }).then((x) => x.json());
    meCache = r.user || null;
    csrfToken = r.csrfToken || null;
  } catch { return null; } // no signal: ask again next time
  return meCache;
}
export const roles = (u) => new Set(u?.platform_roles || []);

// ---------- UI primitives ----------
export function toast(msg, kind = "") {
  let box = $(".toasts");
  if (!box) { box = document.createElement("div"); box.className = "toasts"; box.setAttribute("role", "status"); box.setAttribute("aria-live", "polite"); document.body.append(box); }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 6000 : 3500);
}

export function dialog(title, bodyTpl, { wide = false, onClose } = {}) {
  const d = document.createElement("dialog");
  if (wide) d.classList.add("wide");
  d.setAttribute("aria-labelledby", "dlg-title");
  render(d, html`<div class="dialog-head"><h2 id="dlg-title">${title}</h2><button class="icon-btn" data-close aria-label="Close">×</button></div><div class="dialog-body">${bodyTpl}</div>`);
  document.body.append(d);
  d.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === d) d.close(); });
  d.addEventListener("close", () => { d.remove(); onClose?.(); });
  d.showModal();
  return d;
}

export function confirmDialog(title, message, { confirm = "Confirm", danger = false, input } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const d = dialog(title, html`<form class="stack" data-f><p>${message}</p>
      ${input ? html`<div class="field"><label for="cd-in">${input.label}</label><input id="cd-in" name="v" ${raw(input.required ? "required" : "")} maxlength="400" placeholder="${input.placeholder || ""}"></div>` : ""}
      <div class="row end"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn ${danger ? "btn-danger" : "btn-dark"}">${confirm}</button></div></form>`,
    { onClose: () => resolve(result) });
    $("form", d).addEventListener("submit", (e) => { e.preventDefault(); result = input ? ($("#cd-in", d).value.trim() || false) : true; d.close(); });
  });
}

export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "radio") { if (el.checked) out[el.name] = el.value; }
    else if (el.value !== "") out[el.name] = el.value;
  }
  return out;
}

// Shows server validation errors next to fields; returns true if handled.
export function showErrors(form, err) {
  $$("[aria-invalid]", form).forEach((el) => el.removeAttribute("aria-invalid"));
  $$(".err", form).forEach((el) => el.remove());
  $(".form-error", form)?.remove();
  const details = err?.details && typeof err.details === "object" ? err.details : null;
  let firstBad;
  if (details) for (const [k, msg] of Object.entries(details)) {
    const el = form.elements[k];
    if (!el || !el.closest) continue;
    el.setAttribute("aria-invalid", "true");
    const e = document.createElement("div"); e.className = "err"; e.id = `${el.id || k}-err`; e.textContent = msg;
    el.setAttribute("aria-describedby", e.id);
    el.closest(".field")?.append(e);
    firstBad ||= el;
  }
  const box = document.createElement("div");
  box.className = "form-error"; box.setAttribute("role", "alert"); box.textContent = err?.message || "Something went wrong.";
  form.prepend(box);
  (firstBad || box).focus?.();
}

// Wraps a form submit: busy state, error display, double-submit protection.
export function onSubmit(form, fn) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit], button:not([type])");
    if (btn?.getAttribute("aria-busy") === "true") return;
    btn?.setAttribute("aria-busy", "true");
    try { $(".form-error", form)?.remove(); await fn(formValues(form), form); }
    catch (err) { showErrors(form, err); }
    finally { btn?.removeAttribute("aria-busy"); }
  });
}

export const badge = (status) => {
  const map = { valid: "good", used: "info", paid: "good", confirmed: "good", completed: "good", approved: "good", published: "good", active: "good", sent: "good", matched: "good", admitted: "good",
    pending: "warn", pending_payment: "warn", requested: "warn", pending_approval: "warn", processing: "warn", scheduled: "warn", draft: "plain", assigned: "info", unassigned: "plain", in_progress: "warn", open: "warn", queued: "warn",
    refunded: "info", partially_refunded: "info", reversed: "info", transferred: "info",
    failed: "bad", declined: "bad", cancelled: "bad", expired: "bad", revoked: "bad", blocked: "bad", lost: "bad", rejected: "bad", suspended: "bad", paid_unfulfilled: "bad", replaced: "plain" };
  return html`<span class="badge ${map[status] || ""}">${String(status || "").replace(/_/g, " ")}</span>`;
};

export function empty(text, action = "") {
  return html`<div class="empty"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6Z"/><path d="M14 5v14" stroke-dasharray="2 2"/></svg><p>${text}</p>${action}</div>`;
}
export const spinner = () => html`<div class="spinner" role="status" aria-label="Loading"></div>`;

export function poster(ev, cls = "") {
  if (ev.image_upload_id) return html`<div class="poster ${cls}"><img src="/media/${ev.image_upload_id}" alt="" loading="lazy"></div>`;
  return html`<div class="poster fallback cat-${ev.category || "other"} ${cls}"><span>${ev.title}</span></div>`;
}

// ---------- brand chrome ----------
export function brand(portal) {
  return html`<a class="brand" href="/" aria-label="TicketRoom home"><img src="/assets/logo-mark.svg" alt="" width="40" height="30"><span><span class="wordmark">TICKET<b>ROOM</b></span><span class="brand-sub">Your event. Your ticket.</span></span></a>${portal ? html`<span class="portal-tag">${portal}</span>` : ""}`;
}

export async function header(el, { portal, links = [], active } = {}) {
  const u = await me();
  const r = roles(u);
  const portals = [];
  if (u) {
    portals.push(["/account", "My tickets"]);
    if (u.organisers?.length) portals.push(["/organisers", "Organiser"]);
    if (u.staff_events?.length || u.organisers?.length) portals.push(["/scan", "Scanner"]);
    if (u.vendors?.length) portals.push(["/pos", "POS"]);
    if (r.has("admin") || r.has("finance") || r.has("support")) portals.push(["/admin", "Admin"]);
  }
  const navLinks = links.length ? links : [["/", "Events"], ["/sell", "Sell tickets"], ["/help", "Help"]];
  render(el, html`<a class="skip" href="#main">Skip to content</a><div class="wrap">${brand(portal)}
    <button class="menu-toggle" aria-expanded="false" aria-controls="nav">Menu</button>
    <nav class="nav" id="nav" aria-label="Main">
      ${navLinks.map(([href, label]) => html`<a href="${href}" ${raw(active === href ? 'aria-current="page"' : "")}>${label}</a>`)}
      ${u ? html`${portals.filter(([h]) => !navLinks.some(([x]) => x === h)).map(([href, label]) => html`<a href="${href}" ${raw(location.pathname.startsWith(href) ? 'aria-current="page"' : "")}>${label}</a>`)}
        <button class="link" data-signout><span class="user-chip"><span class="avatar" aria-hidden="true">${initials(u.full_name)}</span>Sign out</span></button>`
      : html`<button class="link" data-signin>Sign in</button><button class="btn btn-primary btn-sm" data-signup>Create account</button>`}
    </nav></div>`);
  const toggle = $(".menu-toggle", el);
  toggle.addEventListener("click", () => { const open = $("#nav", el).classList.toggle("open"); toggle.setAttribute("aria-expanded", String(open)); });
  $("[data-signin]", el)?.addEventListener("click", () => authDialog("signin"));
  $("[data-signup]", el)?.addEventListener("click", () => authDialog("signup"));
  $("[data-signout]", el)?.addEventListener("click", async () => { await post("/api/auth/logout"); location.href = "/"; });
  if (u?.mustChangePassword && !$(".pw-nag")) {
    const nag = document.createElement("div");
    nag.className = "pw-nag";
    nag.setAttribute("role", "status");
    render(nag, html`<div class="wrap">You're signed in with the temporary password. <a href="/account#/settings">Change it now</a>.</div>`);
    el.after(nag);
  }
  maintenanceScreen(u).catch(() => {});
  // Gate, till and back-office screens stay uncluttered: no banner or assistant there.
  if (!/^\/(scan|pos|admin)(\/|$)/.test(location.pathname)) siteExtras().catch(() => {});
  return u;
}

// While maintenance mode is on, visitors see only the message. TicketRoom
// staff see the site as normal, and the sign-in page stays open for them.
async function maintenanceScreen(u) {
  if (roles(u).size || /^\/(admin|signin)(\/|$)/.test(location.pathname) || $(".maint-screen")) return;
  const s = await siteInfo();
  if (!s?.maintenance) return;
  const box = document.createElement("div");
  box.className = "maint-screen";
  render(box, html`<main class="maint-card"><img src="/assets/ticketroom-logo.png" alt="TicketRoom" width="520" height="260"><h1>We'll be right back</h1><p>${s.maintenance.message}</p>
    <p class="small">Questions? <a href="mailto:hello@ticketroom.co.za">hello@ticketroom.co.za</a></p></main>`);
  document.body.append(box);
  document.documentElement.classList.add("maint-on");
  document.title = "TicketRoom | Back soon";
}

export function footer(el) {
  render(el, html`<div class="wrap"><div class="footer-grid">
    <div>${brand()}<p class="mt small">Tickets for concerts, comedy, sport and festivals across South Africa.</p>
      <p class="small mb-0"><a href="mailto:hello@ticketroom.co.za" data-support-email>hello@ticketroom.co.za</a><br><span data-hours-line>Monday to Friday, 9am to 5pm</span></p></div>
    <div><h4>Attendees</h4><ul><li><a href="/">Find events</a></li><li><a href="/account">My tickets</a></li><li><a href="/account#/transfers">Transfer a ticket</a></li><li><a href="/help">Help centre</a></li><li><a href="/contact">Request a callback</a></li></ul></div>
    <div><h4>Organisers</h4><ul><li><a href="/sell">Sell tickets</a></li><li><a href="/organisers">Organiser portal</a></li><li><a href="/scan">Gate scanner</a></li><li data-feature="pos"><a href="/pos">Vendor POS</a></li></ul></div>
    <div><h4>Legal</h4><ul><li><a href="/legal/terms-of-use">Terms of Use</a></li><li><a href="/legal/terms">Terms and Conditions</a></li><li><a href="/legal/privacy">Privacy Policy</a></li><li><a href="/legal/cookies">Cookie Policy</a></li><li><a href="/legal/paia">PAIA manual</a></li><li><a href="/unsubscribe">Unsubscribe</a></li></ul></div>
  </div><div class="legal-line">© ${new Date().getFullYear()} TicketRoom (Pty) Ltd · Reg. no. K2026811077 · ticketroom.co.za · Prices are in South African rand.</div></div>`);
  siteExtras().catch(() => {});
}

// ---------- site information: banner, hours, assistant, callback ----------
let sitePromise;
export const siteInfo = (force = false) => {
  if (!sitePromise || force) sitePromise = fetch("/api/site", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return sitePromise;
};
const store = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } } };
const hashText = (t) => { let h = 0; for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) | 0; return String(h); };
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const hm = (t) => { const [h, m] = String(t).split(":").map(Number); const ap = h >= 12 ? "pm" : "am"; const hh = h % 12 || 12; return m ? `${hh}:${String(m).padStart(2, "0")}${ap}` : `${hh}${ap}`; };

export function hoursText(hours) {
  if (!hours) return "";
  if (hours.openNow) return "We're open now";
  const n = hours.nextOpen;
  const when = n ? (n.date === hours.today ? `today at ${hm(n.time)}` : `${DAY_NAMES[n.day]} at ${hm(n.time)}`) : "soon";
  return `${hours.holiday ? `Closed for ${hours.holiday}` : "We're closed right now"} · back ${when}`;
}
export function weekTable(hours) {
  return html`<dl class="dl hours">${Object.keys(DAY_NAMES).map((d) => html`<dt>${DAY_NAMES[d]}</dt><dd>${hours.week[d] ? `${hm(hours.week[d].open)} – ${hm(hours.week[d].close)}` : "Closed"}</dd>`)}<dt>Public holidays</dt><dd>Closed</dd></dl>`;
}

export async function siteExtras() {
  const s = await siteInfo();
  if (!s) return;
  $$("[data-support-email]").forEach((a) => { a.href = `mailto:${s.support.email}`; a.textContent = s.support.email; });
  $$("[data-hours-line]").forEach((x) => { x.textContent = s.hours.note || "Monday to Friday, 9am to 5pm"; });
  if (s.banner && !$(".site-banner") && store.get("tr_banner_hidden") !== hashText(s.banner.text)) {
    const b = document.createElement("div");
    b.className = "site-banner"; b.setAttribute("role", "region"); b.setAttribute("aria-label", "Announcement");
    render(b, html`<div class="wrap"><p><span class="pill" aria-hidden="true">New</span> ${s.banner.text} ${s.banner.linkText && s.banner.linkUrl ? html`<a href="${s.banner.linkUrl}">${s.banner.linkText} →</a>` : ""}</p><button class="icon-btn" data-hide aria-label="Hide announcement">×</button></div>`);
    $("[data-hide]", b).addEventListener("click", () => { store.set("tr_banner_hidden", hashText(s.banner.text)); b.remove(); });
    document.body.prepend(b);
  }
  if (s.chatbot?.enabled && !$(".chat-fab")) chatWidget(s);
}

export async function callbackDialog({ topic = "callback", message = "", source = "web" } = {}) {
  const [s, u] = await Promise.all([siteInfo(), me()]);
  const resp = s?.support?.responseTime || "24–48 hours";
  const d = dialog("Request a callback", html`<form class="stack" novalidate>
    <p class="muted mb-0">Leave your details and our team will get back to you within <strong>${resp}</strong>${s ? html` (${s.hours.note || "Monday to Friday, 9am to 5pm"})` : ""}.</p>
    ${s && !s.hours.openNow ? html`<p class="callout warn mb-0">${hoursText(s.hours)}. Your request is saved and handled first thing.</p>` : ""}
    ${callbackFields(u, topic, message)}
    <button class="btn btn-primary btn-block">Request callback</button>
    <p class="tiny muted mb-0">We use these details only to respond to you. See our <a href="/legal/privacy" target="_blank">Privacy Policy</a>.</p></form>`);
  onSubmit($("form", d), async (v) => {
    const r = await post("/api/site/callback", { ...v, source });
    render($(".dialog-body", d), html`<div class="stack center"><h3>Thanks, we've got it</h3><p>Your reference is <strong>${r.reference}</strong>. We'll contact you within ${r.responseTime}. A confirmation is on its way to your email.</p><button class="btn btn-dark" data-close>Done</button></div>`);
  });
  return d;
}

export function callbackFields(u, topic = "callback", message = "") {
  const topics = [["callback", "General question"], ["tickets", "My tickets or an order"], ["payment", "A payment"], ["refund", "A refund"], ["tag", "Wristband or tag"], ["account", "My account"], ["organiser", "Selling tickets / organisers"], ["advertising", "Advertising with TicketRoom"], ["other", "Something else"]];
  return html`<div class="grid-2"><div class="field"><label for="cb-name">Full name</label><input id="cb-name" name="fullName" autocomplete="name" required maxlength="120" value="${u?.full_name || ""}"></div>
    <div class="field"><label for="cb-phone">Phone number</label><input id="cb-phone" name="phone" type="tel" autocomplete="tel" required placeholder="082 123 4567" value="${u?.phone || ""}"></div></div>
    <div class="grid-2"><div class="field"><label for="cb-email">Email</label><input id="cb-email" name="email" type="email" autocomplete="email" required value="${u?.email || ""}"></div>
    <div class="field"><label for="cb-topic">Topic</label><select id="cb-topic" name="topic">${topics.map(([v, l]) => html`<option value="${v}" ${raw(v === topic ? "selected" : "")}>${l}</option>`)}</select></div></div>
    <div class="field"><label for="cb-time">Best time to call <span class="muted">(optional)</span></label><input id="cb-time" name="preferredTime" maxlength="60" placeholder="e.g. weekday mornings"></div>
    <div class="field"><label for="cb-msg">How can we help?</label><textarea id="cb-msg" name="message" required maxlength="2000" placeholder="Include your order reference if you have one.">${message}</textarea></div>`;
}

function chatWidget(s) {
  const KEY = "tr_chat_v1";
  let state; try { state = JSON.parse(store.get(KEY) || "null"); } catch { state = null; }
  if (!state?.conversation) state = { conversation: idem().replace(/[^A-Za-z0-9]/g, "").slice(0, 24), log: [] };
  const save = () => store.set(KEY, JSON.stringify({ conversation: state.conversation, log: state.log.slice(-30) }));
  const fab = document.createElement("button");
  fab.className = "chat-fab"; fab.setAttribute("aria-label", "Chat with the TicketRoom assistant"); fab.setAttribute("aria-expanded", "false"); fab.setAttribute("aria-controls", "chat-panel");
  render(fab, html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg><span>Help</span>`);
  const panel = document.createElement("section");
  panel.className = "chat-panel"; panel.id = "chat-panel"; panel.hidden = true; panel.setAttribute("aria-label", "TicketRoom assistant");
  const starters = ["Where are my tickets?", "How do I list a free event?", "What are your fees?", "How do refunds work?"];
  render(panel, html`<header><div><strong>TicketRoom assistant</strong><span class="tiny" data-status>${hoursText(s.hours)}</span></div><button class="icon-btn" data-x aria-label="Close chat">×</button></header>
    <div class="chat-log" aria-live="polite"></div>
    <div class="chat-starters">${starters.map((q) => html`<button class="chip" data-q="${q}">${q}</button>`)}</div>
    <form class="chat-form"><label class="sr-only" for="chat-in">Your question</label><input id="chat-in" maxlength="500" autocomplete="off" placeholder="Ask a question…"><button class="btn btn-primary btn-sm">Send</button></form>
    <footer class="tiny"><button class="btn-link" data-cb>Request a callback</button> · <a href="mailto:${s.support.email}">${s.support.email}</a></footer>`);
  document.body.append(fab, panel);
  const log = $(".chat-log", panel);
  const bubble = (m) => {
    const el = document.createElement("div");
    el.className = `msg ${m.role}`;
    render(el, html`<p>${m.text}</p>${m.link ? html`<a class="small" href="${m.link}">Open this page →</a>` : ""}
      ${m.callback ? html`<button class="btn btn-dark btn-sm" data-cbq>Request a callback</button>` : ""}
      ${m.suggestions?.length ? html`<div class="chips">${m.suggestions.map((q) => html`<button class="chip" data-q="${q}">${q}</button>`)}</div>` : ""}
      ${m.id && m.helpful === undefined ? html`<div class="fb tiny">Helpful? <button class="btn-link" data-fb="1">Yes</button> <button class="btn-link" data-fb="0">No</button></div>` : ""}`);
    $("[data-cbq]", el)?.addEventListener("click", () => callbackDialog({ source: "chat", message: lastQuestion() }));
    $$("[data-fb]", el).forEach((b) => b.addEventListener("click", () => {
      m.helpful = b.dataset.fb === "1"; save();
      post(`/api/site/chat/${m.id}/feedback`, { helpful: m.helpful }).catch(() => {});
      render($(".fb", el), m.helpful ? "Thanks for the feedback." : html`Sorry about that. <button class="btn-link" data-cbq2>Ask us to call you</button> and someone from our team will help.`);
      $("[data-cbq2]", el)?.addEventListener("click", () => callbackDialog({ source: "chat", message: lastQuestion() }));
    }));
    $$("[data-q]", el).forEach((b) => b.addEventListener("click", () => ask(b.dataset.q)));
    log.append(el); log.scrollTop = log.scrollHeight;
  };
  const lastQuestion = () => [...state.log].reverse().find((m) => m.role === "user")?.text || "";
  const draw = () => {
    log.textContent = "";
    bubble({ role: "assistant", text: s.chatbot.greeting || "Hi! I'm the TicketRoom assistant. Ask me about tickets, events, refunds or selling tickets." });
    state.log.forEach(bubble);
    $(".chat-starters", panel).hidden = state.log.length > 0;
  };
  let busy = false;
  const ask = async (q) => {
    q = String(q || "").trim();
    if (!q || busy) return;
    busy = true;
    $(".chat-starters", panel).hidden = true;
    const history = state.log.slice(-8).map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }));
    const mine = { role: "user", text: q }; state.log.push(mine); bubble(mine);
    const typing = document.createElement("div"); typing.className = "msg assistant typing"; typing.textContent = "…"; log.append(typing);
    try {
      const r = await post("/api/site/chat", { message: q, conversation: state.conversation, history });
      const m = { role: "assistant", id: r.id, text: r.text, link: r.link, callback: r.callback, suggestions: r.suggestions };
      state.log.push(m); typing.remove(); bubble(m);
      if (r.hours) $("[data-status]", panel).textContent = hoursText(r.hours);
    } catch (err) {
      typing.remove();
      bubble({ role: "assistant", text: err.status === 429 ? "You're sending messages quickly. Please wait a moment and try again." : `${err.message} You can ask us to call you instead, and we'll get back to you within ${s.support.responseTime}.`, callback: true });
    } finally { busy = false; save(); }
  };
  const toggle = (open) => {
    panel.hidden = !open; fab.setAttribute("aria-expanded", String(open)); fab.classList.toggle("open", open);
    if (open) { if (!log.childElementCount) draw(); $("#chat-in").focus(); }
  };
  fab.addEventListener("click", () => toggle(panel.hidden));
  $("[data-x]", panel).addEventListener("click", () => { toggle(false); fab.focus(); });
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { toggle(false); fab.focus(); } });
  $("[data-cb]", panel).addEventListener("click", () => callbackDialog({ source: "chat", message: lastQuestion() }));
  $$("[data-q]", $(".chat-starters", panel)).forEach((b) => b.addEventListener("click", () => ask(b.dataset.q)));
  $(".chat-form", panel).addEventListener("submit", (e) => { e.preventDefault(); const i = $("#chat-in"); ask(i.value); i.value = ""; });
  window.addEventListener("tr:chat", (e) => { toggle(true); if (e.detail) ask(e.detail); });
}

export function authDialog(mode = "signin", { onDone, reason } = {}) {
  const signup = mode === "signup";
  const d = dialog(signup ? "Create your TicketRoom account" : "Sign in", html`
    ${reason ? html`<p class="callout">${reason}</p>` : ""}
    <form class="stack" novalidate>
      ${signup ? html`<div class="field"><label for="a-name">Full name</label><input id="a-name" name="fullName" autocomplete="name" required></div>` : ""}
      <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="email" required></div>
      ${signup ? html`<div class="field"><label for="a-phone">Mobile number <span class="muted">(optional)</span></label><input id="a-phone" name="phone" type="tel" autocomplete="tel" placeholder="082 123 4567"><span class="hint">For ticket SMSes if you choose.</span></div>` : ""}
      <div class="field"><label for="a-pass">Password</label><input id="a-pass" name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" required minlength="${signup ? 10 : 1}">${signup ? html`<span class="hint">At least 10 characters.</span>` : ""}</div>
      ${signup ? html`<label class="check"><input type="checkbox" name="acceptTerms"><span>I accept the <a href="/legal/terms-of-use" target="_blank">Terms of Use</a> and <a href="/legal/terms" target="_blank">Terms and Conditions</a>, and have read the <a href="/legal/privacy" target="_blank">Privacy Policy</a>.</span></label>
        <label class="check"><input type="checkbox" name="marketingOptIn"><span>Send me TicketRoom event news by email. You can unsubscribe at any time.</span></label>` : ""}
      <button class="btn btn-primary btn-block" type="submit">${signup ? "Create account" : "Sign in"}</button>
      <div class="row between small">${signup ? html`<span>Already have an account? <button type="button" class="btn-link" data-switch>Sign in</button></span>`
        : html`<button type="button" class="btn-link" data-forgot>Forgot password?</button><span>New here? <button type="button" class="btn-link" data-switch>Create account</button></span>`}</div>
    </form>`);
  const form = $("form", d);
  onSubmit(form, async (v) => {
    await post(signup ? "/api/auth/register" : "/api/auth/login", v);
    await me(true);
    d.close();
    toast(signup ? "Welcome to TicketRoom." : "Signed in.", "good");
    if (onDone) onDone(); else location.reload();
  });
  $("[data-switch]", d).addEventListener("click", () => { d.close(); authDialog(signup ? "signin" : "signup", { onDone, reason }); });
  $("[data-forgot]", d)?.addEventListener("click", () => { d.close(); forgotDialog(); });
  setTimeout(() => $("input", form)?.focus(), 50);
  return d;
}

function forgotDialog() {
  const d = dialog("Reset your password", html`<form class="stack"><p class="muted">We will email you a link to choose a new password.</p>
    <div class="field"><label for="f-email">Email</label><input id="f-email" name="email" type="email" required autocomplete="email"></div>
    <button class="btn btn-dark btn-block">Send reset link</button></form>`);
  onSubmit($("form", d), async (v) => { const r = await post("/api/auth/password/forgot", v); d.close(); toast(r.message, "good"); });
}

export async function requireUser(reason) {
  const u = await me();
  if (u) return u;
  await new Promise((resolve) => authDialog("signin", { reason, onDone: resolve }));
  return me(true);
}

// ---------- tiny hash router for portals ----------
export function router(routes, fallback) {
  const go = async () => {
    const path = location.hash.replace(/^#/, "") || "/";
    for (const [pattern, fn] of routes) {
      const keys = [];
      const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
      const m = path.match(re);
      if (m) {
        const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        try { await fn(params); } catch (err) { console.error(err); toast(err.message || "Something went wrong.", "bad"); }
        document.querySelectorAll(".sidenav a").forEach((a) => {
          const target = a.getAttribute("href").replace(/^#/, "");
          a.toggleAttribute("aria-current", target === "/" ? path === "/" : path === target || path.startsWith(target + "/"));
          if (a.hasAttribute("aria-current")) a.setAttribute("aria-current", "page");
        });
        $("#main")?.focus({ preventScroll: true });
        return;
      }
    }
    fallback?.();
  };
  window.addEventListener("hashchange", go);
  go();
  return go;
}

// ---------- single-series bar chart (SVG, native hover tooltips) ----------
export function barChart(data, { height = 180, label = (d) => d.label, value = (d) => d.value, fmt = (v) => String(v), title = "Chart", tickEvery = 1 } = {}) {
  const W = 720, H = height, padL = 44, padB = 26, padT = 10;
  const max = Math.max(1, ...data.map(value));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const bw = (W - padL) / Math.max(1, data.length);
  const gap = Math.min(6, bw * 0.25);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const grid = [0, 0.5, 1].map((f) => { const v = top * f; return `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`; }).join("");
  const bars = data.map((d, i) => {
    const v = value(d), x = padL + i * bw + gap / 2, h = Math.max(0, H - padB - y(v)), w = Math.max(1, bw - gap);
    const r = Math.min(4, w / 2, h);
    const yTop = H - padB - h;
    const path = h > 0 ? `M${x},${H - padB} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${H - padB} Z` : "";
    const tick = i % tickEvery === 0 ? `<text class="axis" x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${esc(label(d))}</text>` : "";
    return `<g><rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent"><title>${esc(label(d))}: ${esc(fmt(v))}</title></rect>${path ? `<path class="bar" d="${path}"><title>${esc(label(d))}: ${esc(fmt(v))}</title></path>` : ""}${tick}</g>`;
  }).join("");
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${bars}</svg>`);
}

// Width of meters is set via CSSOM (allowed under CSP), not style attributes.
export function paintMeters(root = document) {
  $$(".meter > i[data-pct]", root).forEach((i) => { i.style.width = `${Math.max(0, Math.min(100, Number(i.dataset.pct)))}%`; });
}
