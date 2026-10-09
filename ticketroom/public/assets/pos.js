// Vendor POS. Rules this screen enforces:
//  - Prices, balances and outcomes come from the server only.
//  - A sale is APPROVED only when the server says so; anything else is not.
//  - If a charge's outcome is unknown (timeout, dropped connection) the till
//    looks up that same request key before anything else can be charged, so a
//    retry can never charge twice.
//  - No offline spending. When the server can't be reached, charging is off.
import { html, render, $, $$, get, post, header, requireUser, toast, money, moneyExact, fmtTime, fmtDateTime, badge, empty, spinner, idem, dialog, onSubmit, api, features } from "/assets/core.js";
import { Camera, readNfc, nfcSupported, beep } from "/assets/reader.js";

const main = $("#main");
const KEY = "tr_terminal_key";
const PENDING = "tr_pos_pending";
let ctx = null, cart = new Map(), online = navigator.onLine, view = "sell";

const termHeaders = () => ({ "x-terminal-key": localStorage.getItem(KEY) || "" });
const tget = (p) => api("GET", p, undefined, { headers: termHeaders(), timeoutMs: 10000 });
const tpost = (p, b, timeoutMs = 15000) => api("POST", p, b, { headers: termHeaders(), timeoutMs });

function setOnline(v) {
  online = v;
  render($("#netbanner"), v ? "" : html`<div class="offline-banner" role="alert">OFFLINE — payments cannot be confirmed. Do not hand over goods.</div>`);
  $$("[data-charge]").forEach((b) => { b.disabled = !v || !cart.size; });
}
setInterval(async () => { try { await fetch("/api/health", { cache: "no-store" }).then((r) => { if (!r.ok) throw 0; }); setOnline(true); } catch { setOnline(false); } }, 15000);
window.addEventListener("offline", () => setOnline(false));
window.addEventListener("online", () => setOnline(true));

function activate(vendors) {
  render(main, html`<h1>Activate this device</h1>
    <p class="muted">Each till needs a terminal key, created once by your manager or the organiser (Vendors & POS → Register terminal). The key stays on this device.</p>
    ${vendors.length ? html`<p class="small">You're on the team for: ${vendors.map((v) => `${v.name} (${v.event_title})`).join(", ")}</p>` : html`<p class="callout warn">You aren't on any vendor's team yet. Ask the organiser to add you.</p>`}
    <form class="stack card" id="act"><div class="field"><label for="tk">Terminal key</label><input id="tk" name="key" required autocomplete="off" class="mono" placeholder="trk_…"></div><button class="btn btn-primary">Activate</button></form>`);
  $("#act").addEventListener("submit", async (e) => { e.preventDefault(); localStorage.setItem(KEY, $("#tk").value.trim()); boot(); });
}

async function boot() {
  if (!localStorage.getItem(KEY)) return activate((await get("/api/pos/vendors")).vendors);
  try { ctx = await tget("/api/pos/context"); }
  catch (err) {
    if (err.status === 401 || err.status === 403) { toast(err.message, "bad"); localStorage.removeItem(KEY); return activate((await get("/api/pos/vendors")).vendors); }
    throw err;
  }
  const pending = JSON.parse(sessionStorage.getItem(PENDING) || "null");
  if (pending) return resolveUncertain(pending);
  draw();
}

function nav() {
  return html`<div class="row between"><div><div class="small muted">${ctx.event.title} · ${ctx.terminal.label}</div><h1 class="mb-0">${ctx.vendor.name}</h1></div><span class="netbar ${online ? "on" : "off"}">● ${online ? "Online" : "Offline"}</span></div>
    <div class="tabs mt" role="tablist">${[["sell", "Sell"], ["history", "Sales"], ["summary", "Summary"]].map(([k, l]) => html`<button role="tab" data-view="${k}" aria-selected="${view === k}">${l}</button>`)}</div>`;
}

function draw() {
  if (view === "history") return history();
  if (view === "summary") return summary();
  const total = [...cart.entries()].reduce((s, [id, q]) => s + ctx.products.find((p) => p.id === id).price_cents * q, 0);
  render(main, html`${nav()}
    ${!ctx.event.cashlessOpen ? html`<p class="callout warn">Cashless payments are not open for this event.</p>` : ""}
    ${ctx.products.length ? html`<div class="products">${ctx.products.map((p) => html`<button class="product" data-add="${p.id}"><b>${p.name}</b><span class="p">${moneyExact(p.price_cents)}</span>${cart.get(p.id) ? html`<span class="qty">${cart.get(p.id)}</span>` : ""}</button>`)}</div>`
      : empty("No products yet. A vendor manager adds them below.")}
    ${ctx.vendor.role !== "cashier" ? html`<details class="card mt"><summary><strong>Manage products</strong></summary><form class="row mt" id="np"><input name="name" required placeholder="Product name" class="grow" aria-label="Product name"><input name="price" required inputmode="decimal" placeholder="Price (R)" aria-label="Price in rand"><button class="btn btn-ghost btn-sm">Add</button></form></details>` : ""}
    <div class="cart-bar"><div class="row between"><div><div class="small muted">${[...cart.values()].reduce((a, b) => a + b, 0)} items</div><div class="cart-total">${moneyExact(total)}</div></div>
      <div class="row">${cart.size ? html`<button class="btn btn-ghost" data-clear>Clear</button>` : ""}<button class="btn btn-primary" data-charge ${cart.size && online && ctx.event.cashlessOpen ? "" : "disabled"}>Charge</button></div></div>
      ${cart.size ? html`<div class="small muted mt">${[...cart.entries()].map(([id, q]) => `${q}× ${ctx.products.find((p) => p.id === id).name}`).join(" · ")} <button class="btn-link" data-minus>remove last</button></div>` : ""}</div>`);
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => { view = b.dataset.view; draw(); }));
  $$("[data-add]").forEach((b) => b.addEventListener("click", () => { cart.set(b.dataset.add, (cart.get(b.dataset.add) || 0) + 1); draw(); }));
  $("[data-clear]")?.addEventListener("click", () => { cart.clear(); draw(); });
  $("[data-minus]")?.addEventListener("click", () => { const last = [...cart.keys()].pop(); const q = cart.get(last) - 1; q ? cart.set(last, q) : cart.delete(last); draw(); });
  $("[data-charge]")?.addEventListener("click", () => readTag(total));
  $("#np")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target; const cents = Math.round(Number(String(f.price.value).replace(",", ".")) * 100);
    try { await post(`/api/pos/vendors/${ctx.vendor.id}/products`, { name: f.name.value, priceCents: cents }); ctx = await tget("/api/pos/context"); draw(); } catch (err) { toast(err.message, "bad"); }
  });
}

// Step 2: identify the payer's tag by camera (QR tag), NFC or typed value.
function readTag(total) {
  let cam = null, abort = null, done = false;
  const d = dialog(`Charge ${moneyExact(total)}`, html`<p class="muted">Scan the attendee's QR tag, or tap their wristband/card${nfcSupported() ? "" : " (NFC needs Chrome on Android)"}.</p>
    <div class="camera" id="pcam"></div><div class="row mt"><button class="btn btn-dark grow" data-c>Use camera</button>${nfcSupported() ? html`<button class="btn btn-dark grow" data-n>Tap NFC</button>` : ""}</div>
    <form class="row mt" id="tm"><label class="sr-only" for="tv">Tag value</label><input id="tv" class="grow mono" placeholder="or paste tag value (TRT1.… / UID)" autocomplete="off"><button class="btn btn-ghost">Use</button></form>`, { onClose: () => { cam?.stop(); abort?.abort(); } });
  const got = (v) => { if (done) return; done = true; cam?.stop(); abort?.abort(); d.close(); total >= ctx.limits.pinThresholdCents ? askPin(v, total) : charge(v); };
  $("[data-c]", d).addEventListener("click", async () => { cam = new Camera($("#pcam", d), got); try { await cam.start(); } catch { toast("Camera unavailable.", "bad"); } });
  $("[data-n]", d)?.addEventListener("click", async () => { abort = new AbortController(); try { await readNfc(got, abort.signal); toast("Hold the tag to the phone."); } catch (err) { toast(`NFC: ${err.message}`, "bad"); } });
  $("#tm", d).addEventListener("submit", (e) => { e.preventDefault(); const v = $("#tv", d).value.trim(); if (v) got(v); });
}

// Step 3 (large purchases): the attendee types their spending PIN.
function askPin(tagInput, total) {
  let pin = "";
  const d = dialog("Attendee PIN", html`<p class="center">Hand the device to the attendee to enter their spending PIN for <strong>${moneyExact(total)}</strong>.</p><div class="pin-dots" aria-live="polite" aria-label="PIN digits entered"></div>
    <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, "⌫", 0, "OK"].map((k) => html`<button type="button" data-k="${k}">${k}</button>`)}</div>`);
  const dots = () => render($(".pin-dots", d), html`${[0, 1, 2, 3, 4, 5].slice(0, Math.max(4, pin.length)).map((i) => html`<i class="${i < pin.length ? "on" : ""}"></i>`)}`);
  dots();
  $$("[data-k]", d).forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k;
    if (k === "⌫") pin = pin.slice(0, -1); else if (k === "OK") { if (pin.length >= 4) { d.close(); charge(tagInput, pin); } return; } else if (pin.length < 6) pin += k;
    dots();
  }));
}

// Step 4: the charge itself. The key is persisted BEFORE sending.
async function charge(tagInput, pin) {
  const pending = { key: idem(), items: [...cart.entries()].map(([productId, quantity]) => ({ productId, quantity })), tagInput, at: Date.now() };
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  showResult("pending");
  try {
    const r = await tpost("/api/pos/sales", { items: pending.items, tagInput, pin, idempotencyKey: pending.key });
    sessionStorage.removeItem(PENDING);
    finish(r);
  } catch (err) {
    if (err.status === 0) return resolveUncertain(pending);
    sessionStorage.removeItem(PENDING);
    showResult("error", err.message);
  }
}

async function resolveUncertain(pending) {
  showResult("uncertain");
  for (let i = 0; i < 20; i++) {
    try {
      const r = await tget(`/api/pos/sales/by-key/${encodeURIComponent(pending.key)}`);
      setOnline(true);
      sessionStorage.removeItem(PENDING);
      if (r.status === "not_found") return showResult("not_charged");
      return finish(r);
    } catch { setOnline(false); await new Promise((res) => setTimeout(res, 3000)); }
  }
  showResult("uncertain", "Still can't reach TicketRoom. Do not hand over goods and do not charge again. Keep this screen open — it will keep checking.");
  setTimeout(() => resolveUncertain(pending), 5000);
}

function finish(r) {
  beep(r.status === "confirmed");
  if (r.status === "confirmed") { cart.clear(); showResult("approved", r); } else showResult("declined", r);
}

function showResult(kind, r) {
  if (!ctx) return;
  const box = {
    pending: html`<div class="verdict idle"><div class="big">CHARGING…</div><div>Waiting for TicketRoom. Don't hand over goods yet.</div></div>`,
    uncertain: html`<div class="verdict warn"><div class="big">CHECKING</div><div>${typeof r === "string" ? r : "Connection dropped. Checking whether this sale went through — it will NOT be charged twice."}</div></div>`,
    not_charged: html`<div class="verdict no"><div class="big">NOT CHARGED</div><div>The sale did not reach TicketRoom. Nothing was taken. You can try again.</div></div>`,
    approved: html`<div class="verdict ok"><div class="big">APPROVED</div><div>${r?.totalCents ? moneyExact(r.totalCents) : ""} · ${r?.reference || ""}</div></div>`,
    declined: html`<div class="verdict no"><div class="big">DECLINED</div><div>${r?.message || ""}</div></div>`,
    error: html`<div class="verdict no"><div class="big">NOT CHARGED</div><div>${r || ""}</div></div>`,
  }[kind];
  render(main, html`${nav()}<div role="status" aria-live="assertive">${box}</div>
    ${["approved", "declined", "not_charged", "error"].includes(kind) ? html`<button class="btn btn-primary btn-block mt" data-next>${kind === "approved" ? "New sale" : "Back to sale"}</button>` : html`<div class="spinner"></div>`}`);
  $("[data-next]")?.addEventListener("click", draw);
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => { if (!sessionStorage.getItem(PENDING)) { view = b.dataset.view; draw(); } }));
}

async function history() {
  render(main, html`${nav()}${spinner()}`);
  const { sales } = await tget("/api/pos/sales");
  render(main, html`${nav()}${sales.length ? html`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Ref</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>
    ${sales.map((s) => html`<tr><td>${fmtTime(s.created_at)}</td><td class="mono small">${s.reference}</td><td class="num">${moneyExact(s.total_cents)}</td><td>${badge(s.status)}${s.decline_reason ? html`<div class="tiny muted">${s.decline_reason.replace(/_/g, " ")}</div>` : ""}${s.refund_status ? html`<div class="tiny">refund ${s.refund_status}</div>` : ""}</td>
      <td>${s.status === "confirmed" && !s.refund_status ? html`<button class="btn btn-ghost btn-sm" data-refund="${s.id}">Refund</button>` : ""}</td></tr>`)}</tbody></table></div>` : empty("No sales yet.")}`);
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => { view = b.dataset.view; draw(); }));
  $$("[data-refund]").forEach((b) => b.addEventListener("click", () => {
    const d = dialog("Request refund", html`<form class="stack"><p class="muted">The organiser or TicketRoom approves refunds. The attendee's balance is restored once approved.</p><div class="field"><label for="rr">Reason</label><input id="rr" name="reason" required minlength="3"></div><button class="btn btn-danger">Request refund</button></form>`);
    onSubmit($("form", d), async (v) => { await tpost(`/api/pos/sales/${b.dataset.refund}/refund`, v); d.close(); toast("Refund requested.", "good"); history(); });
  }));
}

async function summary() {
  const s = await tget("/api/pos/summary");
  render(main, html`${nav()}<div class="kpis"><div class="kpi card"><div class="k">Sales</div><div class="v">${s.confirmed_count}</div></div><div class="kpi card"><div class="k">Gross</div><div class="v">${money(s.gross_cents)}</div></div>
    <div class="kpi card"><div class="k">Commission</div><div class="v">${money(s.commission_cents)}</div></div><div class="kpi card"><div class="k">Owed to you</div><div class="v">${money(s.payableCents)}</div></div></div>
    <h2 class="mt-lg">Top products</h2>${s.byProduct.length ? html`<div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Sales</th></tr></thead><tbody>${s.byProduct.map((p) => html`<tr><td>${p.name}</td><td class="num">${p.qty}</td><td class="num">${moneyExact(p.cents)}</td></tr>`)}</tbody></table></div>` : empty("No sales yet.")}
    <p class="small muted mt">${s.declined_count} declined attempts · ${moneyExact(s.reversed_cents)} reversed</p>
    <button class="btn btn-ghost mt" data-deact>Deactivate this device</button>`);
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => { view = b.dataset.view; draw(); }));
  $("[data-deact]").addEventListener("click", () => { localStorage.removeItem(KEY); location.reload(); });
}

(async () => {
  await header($("#header"), { portal: "POS", links: [["/pos", "POS"]] });
  if (!(await features()).pos) {
    return render(main, html`<div class="card pad-lg stack"><h1>Vendor point of sale is coming soon</h1>
      <p>Cashless payments and the vendor till arrive together with paid ticket sales. Until then, vendors at your events can take payment the way they usually do.</p>
      <div class="row"><a class="btn btn-primary" href="/organisers">Back to the organiser portal</a><a class="btn btn-ghost" href="/contact?topic=organiser">Ask us about it</a></div></div>`);
  }
  const u = await requireUser("Vendor staff sign in.");
  if (!u) return render(main, empty("Sign in to use the POS."));
  await header($("#header"), { portal: "POS", links: [["/pos", "POS"]] });
  setOnline(navigator.onLine);
  try { await boot(); } catch (err) { render(main, html`<div class="verdict no"><div class="big">UNAVAILABLE</div><div>${err.message}</div></div>`); }
})();
void fmtDateTime;
