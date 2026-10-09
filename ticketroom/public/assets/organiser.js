// Organiser portal: events, tickets, promo/tracking, analytics, attendees,
// staff, vendors & terminals, refunds, finance & payouts, marketing.
import { html, raw, render, $, $$, get, post, patch, put, del, api, money, moneyExact, fmtDate, fmtTime, fmtDateTime, toLocalInput, header, requireUser, toast, onSubmit, badge, empty, spinner, dialog, confirmDialog, parseRand, router, barChart, paintMeters, me, features, gate, isStaff, qrPanel } from "/assets/core.js";

const main = $("#main");
let ORG = null;
let FEATURES = { cashless: true, sms: true };           // current organiser
let ORGS = [];

const head = (title, sub = "", actions = "", crumbs = "") => html`${crumbs ? html`<div class="crumbs">${crumbs}</div>` : ""}<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p class="muted">${sub}</p>` : ""}</div><div class="row">${actions}</div></div>`;
const can = (...roles) => ORG && (roles.includes(ORG.role) || ORG.role === "admin");
const base = () => `/api/organiser/${ORG.id}`;

function nav() {
  render($("#sidenav"), html`
    ${ORGS.length > 1 ? html`<div class="org-switch"><label class="sr-only" for="orgsel">Organisation</label><select id="orgsel">${ORGS.map((o) => html`<option value="${o.id}" ${raw(o.id === ORG?.id ? "selected" : "")}>${o.name}</option>`)}</select></div>` : ORG ? html`<div class="sect">${ORG.name}</div>` : ""}
    <a href="#/">Dashboard</a><a href="#/events">My events</a><a href="#/marketing">Marketing</a><a href="#/refunds" data-feature="finance">Refunds</a><a href="#/finance" data-feature="finance">Finance & payouts</a><a href="#/team">Team</a><a href="#/settings">Settings</a>
    <div class="sect">Tools</div><a href="/scan">Gate scanner</a><a href="/pos" data-feature="pos">Vendor POS</a>`);
  $("#orgsel")?.addEventListener("change", (e) => { localStorage.setItem("tr_org", e.target.value); location.hash = "#/"; location.reload(); });
}

function pendingBanner() {
  if (ORG.status === "approved") return "";
  return html`<p class="callout ${ORG.status === "pending" ? "warn" : "bad"}"><strong>${ORG.status === "pending" ? "Your organiser account is being reviewed." : `Your organiser account is ${ORG.status}.`}</strong> ${ORG.status === "pending" ? "You can build events now; you can submit them for publishing and send marketing once TicketRoom approves your account (usually within 1 business day)." : "Contact hello@ticketroom.co.za."}</p>`;
}

// ---------------- apply ----------------
async function apply() {
  const u = await me();
  // A TicketRoom staff account opening the organiser portal: explain instead of
  // offering the sign-up form (which would make the company email an organiser).
  if (isStaff(u)) {
    return render(main, html`${head("This is the organiser portal")}
      <div class="card stack"><p class="mb-0">You're signed in as <strong>${u.email}</strong>, a TicketRoom staff account. Staff work in the admin portal; they don't sign up as organisers.</p>
        <p class="mb-0">To review organisers, open <strong>Organiser accounts</strong> in the admin portal. To try the organiser portal yourself, sign out and create a separate account with a different email.</p>
        <div class="row"><a class="btn btn-primary" href="/admin#/organisers">Go to Organiser accounts</a><button class="btn btn-ghost" data-out>Sign out</button></div></div>`), $("[data-out]").addEventListener("click", async () => { await post("/api/auth/logout"); location.href = "/signin"; });
  }
  render(main, html`${head("Create your organiser account", "Tell us who you are. TicketRoom reviews every organiser before their events go live.")}
    <div class="card"><form class="stack" id="ap">
      <div class="field"><label for="n">Organisation or trading name</label><input id="n" name="name" required maxlength="120"></div>
      <div class="grid-2"><div class="field"><label for="ce">Contact email</label><input id="ce" name="contactEmail" type="email" required><span class="hint">Where TicketRoom and your ticket buyers reach you. We've filled in your sign-in email; change it if you use another.</span></div>
      <div class="field"><label for="cp">Contact number</label><input id="cp" name="contactPhone" type="tel" placeholder="082 123 4567"></div></div>
      <div class="field"><label for="d">About your events</label><textarea id="d" name="description" maxlength="2000" placeholder="What kind of events do you run, and where?"></textarea></div>
      <button class="btn btn-primary">Submit for review</button></form></div>`);
  $("#ce").value = u.email;
  if (u.phone) $("#cp").value = u.phone;
  onSubmit($("#ap"), async (v) => { const r = await post("/api/organiser/apply", v); localStorage.setItem("tr_org", r.organiser.id); toast("Organiser account created.", "good"); location.hash = "#/"; location.reload(); });
}

// ---------------- dashboard ----------------
async function dashboard() {
  const d = await get(`${base()}/dashboard`);
  const t = d.totals;
  const upcoming = d.events.filter((e) => new Date(e.starts_at) > new Date()).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  render(main, html`${head(`Hi, ${ORG.name}`, "Here's how your events are selling.", can("owner", "manager") ? html`<a class="btn btn-primary" href="#/events/new">Create event</a>` : "")}
    ${pendingBanner()}
    <div class="kpis"><div class="kpi"><div class="k">Ticket revenue</div><div class="v">${money(t.revenueCents)}</div><div class="s">after discounts, before fees</div></div>
      <div class="kpi"><div class="k">Tickets sold</div><div class="v">${t.ticketsSold.toLocaleString("en-ZA")}</div><div class="s">across ${t.events} event${t.events === 1 ? "" : "s"}</div></div>
      <div class="kpi"><div class="k">Last 7 days</div><div class="v">${money(t.last7RevenueCents)}</div><div class="s">${t.last7Orders} order${t.last7Orders === 1 ? "" : "s"}</div></div>
      <div class="kpi"><div class="k">Live events</div><div class="v">${t.live}</div><div class="s">published & upcoming</div></div></div>
    <section class="card mt"><div class="card-title"><h2>Upcoming events</h2><a href="#/events">All events</a></div>
      ${upcoming.length ? html`<div class="table-wrap"><table><thead><tr><th>Event</th><th>Date</th><th>Status</th><th>Sold</th><th class="num">Revenue</th></tr></thead><tbody>
        ${upcoming.map((e) => html`<tr><td><a href="#/events/${e.id}">${e.title}</a></td><td>${fmtDate(e.starts_at)}</td><td>${badge(e.status)}</td>
          <td><div class="small">${e.sold} / ${e.capacity}</div><div class="meter"><i data-pct="${(e.sold / e.capacity) * 100}"></i></div></td><td class="num">${moneyExact(e.revenue_cents)}</td></tr>`)}
      </tbody></table></div>` : empty("No upcoming events.", can("owner", "manager") ? html`<a class="btn btn-primary" href="#/events/new">Create your first event</a>` : "")}</section>`);
  paintMeters(main);
}

// ---------------- events list & editor ----------------
async function events() {
  const list = await get(`${base()}/events`);
  render(main, html`${head("My events", "", can("owner", "manager") ? html`<a class="btn btn-primary" href="#/events/new">Create event</a>` : "")}${pendingBanner()}
    ${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Event</th><th>Date</th><th>Status</th><th>Sold</th><th class="num">Revenue</th></tr></thead><tbody>
      ${list.map((e) => html`<tr><td><a href="#/events/${e.id}"><strong>${e.title}</strong></a></td><td>${fmtDateTime(e.starts_at)}</td><td>${badge(e.status)}</td><td>${e.sold} / ${e.capacity}</td><td class="num">${moneyExact(e.revenue_cents)}</td></tr>`)}
    </tbody></table></div>` : empty("No events yet.")}`);
}

const CATS = ["music", "festival", "comedy", "sport", "arts", "food", "business", "family", "nightlife", "other"];
const PROVINCES = ["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"];

function eventForm(e = {}) {
  const sel = (v, cur) => raw(v === cur ? "selected" : "");
  return html`<form class="stack" id="evf">
    <label class="check card flat"><input type="checkbox" name="isFree" ${raw(e.is_free ? "checked" : "")}><span><strong>This is a free event</strong><br><span class="small muted">No ticket price, no booking fee and no commission. Attendees register for free tickets with a QR code. We'll create a "Free admission" ticket type for you.</span></span></label>
    <div class="field"><label for="title">Event name</label><input id="title" name="title" required maxlength="140" value="${e.title || ""}"></div>
    <div class="field"><label for="summary">One-line summary</label><input id="summary" name="summary" maxlength="240" value="${e.summary || ""}" placeholder="Shown on event cards"></div>
    <div class="grid-2"><div class="field"><label for="category">Category</label><select id="category" name="category">${CATS.map((c) => html`<option value="${c}" ${sel(c, e.category)}>${c}</option>`)}</select></div>
      <div class="field"><label for="capacity">Total capacity</label><input id="capacity" name="capacity" type="number" min="1" required value="${e.capacity || ""}"></div></div>
    <div class="grid-2"><div class="field"><label for="startsAt">Starts</label><input id="startsAt" name="startsAt" type="datetime-local" required value="${toLocalInput(e.starts_at)}"></div>
      <div class="field"><label for="endsAt">Ends</label><input id="endsAt" name="endsAt" type="datetime-local" required value="${toLocalInput(e.ends_at)}"></div></div>
    <div class="grid-2"><div class="field"><label for="venueName">Venue</label><input id="venueName" name="venueName" required value="${e.venue_name || ""}"></div>
      <div class="field"><label for="address">Street address</label><input id="address" name="address" value="${e.address || ""}"></div></div>
    <div class="grid-2"><div class="field"><label for="city">City</label><input id="city" name="city" required value="${e.city || ""}"></div>
      <div class="field"><label for="province">Province</label><select id="province" name="province"><option value="">—</option>${PROVINCES.map((p) => html`<option ${sel(p, e.province)}>${p}</option>`)}</select></div></div>
    <div class="field"><label for="description">Description</label><textarea id="description" name="description" maxlength="8000">${e.description || ""}</textarea></div>
    <div class="field"><label for="img">Poster image</label><input id="img" type="file" accept="image/png,image/jpeg,image/webp"><input type="hidden" name="imageUploadId" value="${e.image_upload_id || ""}"><span class="hint">PNG, JPEG or WebP, up to 2 MB. 16:9 works best.</span></div>
    <div class="grid-2"><div class="field"><label for="salesStartAt">Sales open <span class="muted">(optional)</span></label><input id="salesStartAt" name="salesStartAt" type="datetime-local" value="${toLocalInput(e.sales_start_at)}"></div>
      <div class="field"><label for="salesEndAt">Sales close <span class="muted">(default: event end)</span></label><input id="salesEndAt" name="salesEndAt" type="datetime-local" value="${toLocalInput(e.sales_end_at)}"></div></div>
    <div class="field"><label for="refundPolicy">Refund policy</label><textarea id="refundPolicy" name="refundPolicy" maxlength="2000">${e.refund_policy || "Tickets are non-refundable unless the event is cancelled or materially changed."}</textarea></div>
    <div class="field"><label for="accessibilityInfo">Accessibility information</label><textarea id="accessibilityInfo" name="accessibilityInfo" maxlength="2000" placeholder="Step-free access, accessible toilets, companion tickets…">${e.accessibility_info || ""}</textarea></div>
    <div class="field"><label for="ageRestriction">Age restriction</label><input id="ageRestriction" name="ageRestriction" maxlength="60" value="${e.age_restriction || ""}" placeholder="e.g. 18+"></div>
    <label class="check"><input type="checkbox" name="transfersEnabled" ${raw(e.transfers_enabled === false ? "" : "checked")}><span>Allow ticket holders to transfer tickets</span></label>
    <label class="check" data-feature="cashless"><input type="checkbox" name="cashlessEnabled" ${raw(e.cashless_enabled ? "checked" : "")}><span>Cashless event (wristbands / tags and vendor POS)</span></label>
    <button class="btn btn-primary" type="submit">${e.id ? "Save changes" : "Create draft"}</button></form>`;
}

function toIso(v) { return v ? new Date(v).toISOString() : undefined; }
function eventPayload(v) {
  return { ...v, capacity: Number(v.capacity), startsAt: toIso(v.startsAt), endsAt: toIso(v.endsAt), salesStartAt: toIso(v.salesStartAt), salesEndAt: toIso(v.salesEndAt),
    imageUploadId: v.imageUploadId || undefined, province: v.province || undefined, transfersEnabled: !!v.transfersEnabled, cashlessEnabled: !!v.cashlessEnabled, isFree: !!v.isFree };
}

function wireUpload(form) {
  $("#img", form).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast("That image is larger than 2 MB.", "bad"); e.target.value = ""; return; }
    try { const r = await api("POST", `${base()}/uploads`, undefined, { raw: file, headers: { "content-type": file.type } }); form.elements.imageUploadId.value = r.uploadId; toast("Image uploaded.", "good"); }
    catch (err) { toast(err.message, "bad"); e.target.value = ""; }
  });
}

function newEvent() {
  render(main, html`${head("Create event", "Start with the basics. You'll add ticket types next.", "", html`<a href="#/events">My events</a>`)}<div class="card">${eventForm()}</div>`);
  const f = $("#evf"); wireUpload(f);
  onSubmit(f, async (v) => { const r = await post(`${base()}/events`, eventPayload(v)); toast("Draft created. Now add ticket types.", "good"); location.hash = `#/events/${r.event.id}/tickets`; });
}

// ---------------- event workspace ----------------
const TABS = [["", "Overview"], ["tickets", "Tickets & pricing"], ["promos", "Promos & links"], ["orders", "Orders"], ["attendees", "Attendees"], ["staff", "Staff"], ["vendors", "Vendors & POS"], ["details", "Details"]];

async function eventWorkspace({ id, tab = "" }) {
  const d = await get(`${base()}/events/${id}`);
  const e = d.event;
  const actions = [];
  if (e.status === "draft" && can("owner", "manager")) actions.push(html`<button class="btn btn-primary" data-submit>Submit for approval</button>`);
  if (e.status === "published") actions.push(html`<a class="btn btn-ghost" href="/events/${e.slug}" target="_blank">View public page ↗</a>`);
  if (can("owner") && !["cancelled", "completed"].includes(e.status)) actions.push(html`<button class="btn btn-ghost" data-cancel>${e.cancellation_requested_at ? "Cancellation requested" : "Cancel event"}</button>`);
  render(main, html`${head(e.title, html`${badge(e.status)} · ${fmtDateTime(e.starts_at)} · ${e.venue_name}, ${e.city}`, html`${actions}`, html`<a href="#/events">My events</a>`)}
    ${e.status === "pending_approval" ? html`<p class="callout">Submitted. TicketRoom will review and publish it shortly.</p>` : ""}
    ${e.status === "draft" && e.status_reason ? html`<p class="callout warn"><strong>Changes requested:</strong> ${e.status_reason}</p>` : ""}
    ${e.cancellation_requested_at && e.status !== "cancelled" ? html`<p class="callout warn">Cancellation requested: ${e.cancellation_reason}. TicketRoom will cancel the event and refund buyers.</p>` : ""}
    <div class="tabs" role="tablist">${TABS.filter(([k]) => k !== "vendors" || FEATURES.cashless).map(([k, l]) => html`<a href="#/events/${id}${k ? "/" + k : ""}" role="tab" aria-selected="${tab === k}">${l}</a>`)}</div>
    <div id="tab"></div>`);
  $("[data-submit]")?.addEventListener("click", async () => { try { await post(`${base()}/events/${id}/submit`); toast("Submitted for approval.", "good"); eventWorkspace({ id, tab }); } catch (err) { toast(err.message, "bad"); } });
  $("[data-cancel]")?.addEventListener("click", async () => {
    if (e.cancellation_requested_at) return;
    const reason = await confirmDialog("Cancel this event?", "If tickets have been sold, TicketRoom cancels the event and refunds every buyer in full, including fees. This cannot be undone.", { confirm: "Request cancellation", danger: true, input: { label: "Reason (shown to buyers)", required: true } });
    if (!reason) return;
    const r = await post(`${base()}/events/${id}/request-cancellation`, { reason }); toast(r.status === "cancelled" ? "Event cancelled." : "Cancellation requested.", "good"); eventWorkspace({ id, tab });
  });
  const el = $("#tab");
  const fns = { "": overviewTab, tickets: ticketsTab, promos: promosTab, orders: ordersTab, attendees: attendeesTab, staff: staffTab, vendors: vendorsTab, details: detailsTab };
  render(el, spinner());
  await fns[tab](el, d, () => eventWorkspace({ id, tab }));
}

// "Share your event": the public link and a QR code to download for posters,
// flyers and socials. Shown on every event; the QR works once it is published.
async function shareCard(el, event) {
  const card = document.createElement("section");
  card.className = "card mt";
  card.setAttribute("aria-labelledby", "share-h");
  el.append(card);
  render(card, html`<div class="card-title"><h3 id="share-h">Share your event</h3></div>${spinner()}`);
  try {
    const q = await get(`${base()}/events/${event.id}/qr`);
    render(card, html`<div class="card-title"><h3 id="share-h">Share your event</h3></div>
      <div class="grid-2"><div class="stack"><p class="mb-0">Your event page:</p><p class="mb-0"><a class="mono small" href="${q.url}" target="_blank" rel="noopener">${q.url}</a></p>
        <div class="row"><button class="btn btn-ghost btn-sm" data-copy>Copy link</button></div>
        ${q.status === "published" ? html`<p class="small muted mb-0">Put the QR code on posters, flyers and slides. Scanning it opens your event page, where people get tickets.</p>`
          : html`<p class="callout warn small mb-0">The QR code opens your event page once the event is published. You can download it now and use it after approval.</p>`}</div>
        <div data-qr></div></div>`);
    $("[data-qr]", card).append(qrPanel(q.svg, { name: `${q.title} QR code`, caption: q.title }));
    $("[data-copy]", card).addEventListener("click", async () => { try { await navigator.clipboard.writeText(q.url); toast("Link copied.", "good"); } catch { toast(q.url); } });
  } catch (err) { render(card, html`<p class="muted mb-0">The QR code could not be made right now: ${err.message}</p>`); }
}

async function overviewTab(el, d) {
  const a = await get(`${base()}/events/${d.event.id}/analytics`);
  const t = a.totals;
  const checkPct = a.checkins.issued ? Math.round((a.checkins.admitted / a.checkins.issued) * 100) : 0;
  render(el, html`<div class="kpis">
      <div class="kpi"><div class="k">Tickets sold</div><div class="v">${t.ticketsSold}</div><div class="s">of ${t.capacity} capacity</div><div class="meter amber mt"><i data-pct="${(t.ticketsSold / t.capacity) * 100}"></i></div></div>
      <div class="kpi"><div class="k">Ticket revenue</div><div class="v">${money(t.ticket_revenue_cents)}</div><div class="s">${t.orders} order${t.orders === 1 ? "" : "s"}${t.refunded_cents ? ` · refunds ${money(t.refunded_cents)}` : ""}</div></div>
      <div class="kpi"><div class="k">Checked in</div><div class="v">${a.checkins.admitted}</div><div class="s">${checkPct}% of ${a.checkins.issued} issued</div></div>
      <div class="kpi"><div class="k">Owed to you</div><div class="v">${money(t.payableCents)}</div><div class="s">${t.abandoned} abandoned checkouts</div></div></div>
    <section class="card mt"><div class="card-title"><h3>Tickets sold per day, last 30 days</h3><button class="btn-link" data-tbl>Show as table</button></div>
      <div class="chart-wrap">${barChart(a.daily, { label: (x) => x.day.slice(8), value: (x) => x.tickets, title: "Tickets sold per day", tickEvery: 3 })}</div>
      <div class="table-wrap hidden mt" id="dtbl"><table><thead><tr><th>Day</th><th class="num">Tickets</th><th class="num">Revenue</th></tr></thead><tbody>${a.daily.filter((x) => x.tickets).map((x) => html`<tr><td>${x.day}</td><td class="num">${x.tickets}</td><td class="num">${moneyExact(x.revenue_cents)}</td></tr>`)}</tbody></table></div></section>
    <div class="grid-2 mt">
      <section class="card"><h3>By ticket type</h3><div class="table-wrap"><table><thead><tr><th>Type</th><th class="num">Price</th><th>Sold</th><th class="num">In</th></tr></thead><tbody>
        ${a.byType.map((x) => html`<tr><td>${x.name}</td><td class="num">${moneyExact(x.price_cents)}</td><td><div class="small">${x.quantity_sold}/${x.quantity_total}${x.quantity_held ? ` (+${x.quantity_held} reserved)` : ""}</div><div class="meter"><i data-pct="${x.quantity_total ? (x.quantity_sold / x.quantity_total) * 100 : 0}"></i></div></td><td class="num">${x.checked_in}</td></tr>`)}</tbody></table></div></section>
      <section class="card"><h3>Sales by channel</h3>${a.trackingLinks.length ? html`<div class="table-wrap"><table><thead><tr><th>Link</th><th class="num">Clicks</th><th class="num">Orders</th><th class="num">Revenue</th></tr></thead><tbody>
        ${a.trackingLinks.map((l) => html`<tr><td>${l.label}<div class="tiny muted mono">${l.code}</div></td><td class="num">${l.clicks}</td><td class="num">${l.orders}</td><td class="num">${moneyExact(l.revenue_cents)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Create tracking links under Promos & links to see which channels sell.</p>`}</section>
      <section class="card"><h3>Check-ins by hour</h3>${a.checkinsByHour.length ? barChart(a.checkinsByHour, { label: (x) => x.hour.slice(0, 2), value: (x) => x.n, title: "Check-ins by hour", height: 150 }) : html`<p class="muted">No scans yet. Gate staff use the Scanner on their phones.</p>`}</section>
      <section class="card"><h3>Promo codes</h3>${a.promoCodes.length ? html`<div class="table-wrap"><table><thead><tr><th>Code</th><th class="num">Used</th><th class="num">Discount given</th></tr></thead><tbody>${a.promoCodes.map((p) => html`<tr><td class="mono">${p.code}</td><td class="num">${p.used_count}${p.max_uses ? `/${p.max_uses}` : ""}</td><td class="num">${moneyExact(p.discount_given_cents)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No promo codes.</p>`}</section>
      ${d.event.cashless_enabled ? html`<section class="card"><h3>Cashless</h3><p>${money(a.cashless.topups_cents)} topped up by ${a.cashless.wallets} attendees.</p>${a.vendors.length ? html`<div class="table-wrap"><table><thead><tr><th>Vendor</th><th class="num">Sales</th><th class="num">Gross</th></tr></thead><tbody>${a.vendors.map((v) => html`<tr><td>${v.name}</td><td class="num">${v.sales}</td><td class="num">${moneyExact(v.gross_cents)}</td></tr>`)}</tbody></table></div>` : ""}</section>` : ""}
    </div>`);
  paintMeters(el);
  $("[data-tbl]", el).addEventListener("click", (ev) => { const t2 = $("#dtbl"); t2.classList.toggle("hidden"); ev.target.textContent = t2.classList.contains("hidden") ? "Show as table" : "Hide table"; });
  shareCard(el, d.event);
}

async function ticketsTab(el, d, reload) {
  const editable = can("owner", "manager");
  render(el, html`<section class="card"><div class="card-title"><h3>Ticket types</h3>${editable ? html`<button class="btn btn-primary btn-sm" data-add>Add ticket type</button>` : ""}</div>
    ${d.ticketTypes.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th class="num">Price</th><th>Quantity</th><th>Per order</th><th>Status</th><th></th></tr></thead><tbody>
      ${d.ticketTypes.map((t) => html`<tr><td><strong>${t.name}</strong>${t.description ? html`<div class="small muted">${t.description}</div>` : ""}</td><td class="num">${t.price_cents ? moneyExact(t.price_cents) : "Free"}</td>
        <td>${t.quantity_sold} sold${t.quantity_held ? `, ${t.quantity_held} reserved` : ""} / ${t.quantity_total}</td><td>${t.per_order_limit}</td><td>${badge(t.status)}</td>
        <td>${editable ? html`<button class="btn btn-ghost btn-sm" data-edit="${t.id}">Edit</button>` : ""}</td></tr>`)}</tbody></table></div>`
      : empty("No ticket types yet. Add at least one before submitting.")}
    <p class="small muted mt mb-0">Buyers pay a service fee per paid ticket on top of your price. Once a ticket type has sales its price is locked. To change the price, add a new release such as "Second release".</p></section>`);
  const form = (t = {}) => {
    const dlg = dialog(t.id ? "Edit ticket type" : "Add ticket type", html`<form class="stack">
      <div class="field"><label for="tn">Name</label><input id="tn" name="name" required maxlength="80" value="${t.name || ""}" placeholder="e.g. Early Bird"></div>
      <div class="field"><label for="td">Description</label><input id="td" name="description" maxlength="240" value="${t.description || ""}"></div>
      <div class="grid-2"><div class="field"><label for="tp">Price (R)</label><input id="tp" name="price" inputmode="decimal" required value="${t.price_cents !== undefined ? t.price_cents / 100 : ""}" ${raw(t.quantity_sold ? "disabled" : "")}><span class="hint">0 for free</span></div>
        <div class="field"><label for="tq">Quantity</label><input id="tq" name="quantityTotal" type="number" min="0" required value="${t.quantity_total ?? ""}"></div></div>
      <div class="grid-2"><div class="field"><label for="tl">Max per order</label><input id="tl" name="perOrderLimit" type="number" min="1" max="50" value="${t.per_order_limit || 10}"></div>
        <div class="field"><label for="ts">Status</label><select id="ts" name="status">${["on_sale", "paused", "hidden"].map((s) => html`<option value="${s}" ${raw(s === (t.status || "on_sale") ? "selected" : "")}>${s.replace("_", " ")}</option>`)}</select></div></div>
      <button class="btn btn-primary">Save</button></form>`);
    onSubmit($("form", dlg), async (v) => {
      const body = { name: v.name, description: v.description, quantityTotal: Number(v.quantityTotal), perOrderLimit: Number(v.perOrderLimit), status: v.status };
      if (v.price !== undefined) { const c = parseRand(v.price); if (c === null) throw Object.assign(new Error("Check the price."), { details: { price: "Enter an amount like 150 or 0." } }); body.priceCents = c; }
      if (t.id) await patch(`${base()}/events/${d.event.id}/ticket-types/${t.id}`, body); else await post(`${base()}/events/${d.event.id}/ticket-types`, body);
      dlg.close(); toast("Saved.", "good"); reload();
    });
  };
  $("[data-add]", el)?.addEventListener("click", () => form());
  $$("[data-edit]", el).forEach((b) => b.addEventListener("click", () => form(d.ticketTypes.find((t) => t.id === b.dataset.edit))));
}

async function promosTab(el, d, reload) {
  const editable = can("owner", "manager", "marketing");
  render(el, html`<div class="grid-2">
    <section class="card"><div class="card-title"><h3>Promo codes</h3></div>
      ${d.promoCodes.length ? html`<div class="table-wrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Used</th><th></th></tr></thead><tbody>
        ${d.promoCodes.map((p) => html`<tr><td class="mono">${p.code}</td><td>${p.kind === "percent" ? `${p.value}%` : moneyExact(p.value)}</td><td>${p.used_count}${p.max_uses ? `/${p.max_uses}` : ""}</td>
          <td>${editable ? html`<button class="btn btn-ghost btn-sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? "Disable" : "Enable"}</button>` : badge(p.active ? "active" : "cancelled")}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No promo codes yet.</p>`}
      ${editable ? html`<form class="stack mt" id="pf"><div class="grid-2"><div class="field"><label for="pc">Code</label><input id="pc" name="code" required maxlength="30" class="mono" placeholder="EARLY10"></div>
        <div class="field"><label for="pk">Type</label><select id="pk" name="kind"><option value="percent">Percentage off</option><option value="fixed">Rand amount off</option></select></div></div>
        <div class="grid-2"><div class="field"><label for="pv">Value</label><input id="pv" name="value" inputmode="decimal" required placeholder="10"></div><div class="field"><label for="pm">Max uses</label><input id="pm" name="maxUses" type="number" min="1" placeholder="Unlimited"></div></div>
        <button class="btn btn-dark">Create code</button></form>` : ""}</section>
    <section class="card"><div class="card-title"><h3>Tracking links</h3></div><p class="small muted">Share a different link per channel (Instagram, WhatsApp, radio) to see which one sells.</p>
      ${d.trackingLinks.length ? html`<div class="stack">${d.trackingLinks.map((l) => html`<div class="card flat"><div class="row between"><strong>${l.label}</strong><span class="small muted">${l.clicks} clicks</span></div><div class="row"><input readonly value="${l.url}" class="mono small grow" aria-label="Link for ${l.label}"><button class="btn btn-ghost btn-sm" data-copy="${l.url}">Copy</button></div></div>`)}</div>` : ""}
      ${editable ? html`<form class="row mt" id="lf"><label class="sr-only" for="ll">Label</label><input id="ll" name="label" required placeholder="e.g. Instagram story" class="grow"><button class="btn btn-dark">Create link</button></form>` : ""}</section></div>`);
  if ($("#pf")) onSubmit($("#pf"), async (v) => {
    const value = v.kind === "percent" ? Number(v.value) : parseRand(v.value);
    await post(`${base()}/events/${d.event.id}/promo-codes`, { code: v.code, kind: v.kind, value, maxUses: v.maxUses ? Number(v.maxUses) : undefined }); toast("Promo code created.", "good"); reload();
  });
  if ($("#lf")) onSubmit($("#lf"), async (v) => { await post(`${base()}/events/${d.event.id}/tracking-links`, v); toast("Link created.", "good"); reload(); });
  $$("[data-toggle]", el).forEach((b) => b.addEventListener("click", async () => { await patch(`${base()}/events/${d.event.id}/promo-codes/${b.dataset.toggle}`, { active: b.dataset.active !== "true" }); reload(); }));
  $$("[data-copy]", el).forEach((b) => b.addEventListener("click", async () => { await navigator.clipboard?.writeText(b.dataset.copy); toast("Copied."); }));
}

async function ordersTab(el, d) {
  const draw = async (q = "") => {
    const { orders } = await get(`${base()}/events/${d.event.id}/orders?q=${encodeURIComponent(q)}`);
    render($("#olist", el), orders.length ? html`<div class="table-wrap"><table><thead><tr><th>Order</th><th>Buyer</th><th>Tickets</th><th class="num">Total</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>
      ${orders.map((o) => html`<tr><td class="mono">${o.reference}</td><td>${o.buyer_name}<div class="small muted">${o.buyer_email}</div></td><td>${o.tickets}</td><td class="num">${moneyExact(o.total_cents)}${o.refunded_cents ? html`<div class="tiny muted">−${moneyExact(o.refunded_cents)}</div>` : ""}</td>
        <td>${badge(o.status)}${o.refund_status ? html`<div class="tiny">refund ${o.refund_status}</div>` : ""}</td><td>${fmtDate(o.created_at)}</td>
        <td>${can("owner", "finance") && ["paid", "partially_refunded"].includes(o.status) && o.total_cents > 0 ? html`<button class="btn btn-ghost btn-sm" data-refund="${o.id}" data-ref="${o.reference}">Refund</button>` : ""}</td></tr>`)}</tbody></table></div>` : empty("No orders yet."));
    $$("[data-refund]", el).forEach((b) => b.addEventListener("click", () => {
      const dlg = dialog(`Refund ${b.dataset.ref}`, html`<form class="stack"><p class="muted">Refunds all valid tickets on this order. TicketRoom finance approves every refund before money moves; the tickets stop working once it completes.</p>
        <div class="field"><label for="rr">Reason</label><input id="rr" name="reason" required minlength="3" maxlength="400"></div>
        <label class="check"><input type="checkbox" name="includeFees"><span>Also refund the buyer's service fees</span></label><button class="btn btn-danger">Request refund</button></form>`);
      onSubmit($("form", dlg), async (v) => { const r = await post(`${base()}/events/${d.event.id}/orders/${b.dataset.refund}/refund`, v); dlg.close(); toast(`Refund ${r.refund.reference} requested (${moneyExact(r.refund.amountCents)}).`, "good"); draw(q); });
    }));
  };
  render(el, html`<form class="row" id="os"><label class="sr-only" for="oq">Search orders</label><input id="oq" class="grow" placeholder="Search by reference, name or email"><button class="btn btn-ghost">Search</button></form><div id="olist" class="mt">${spinner()}</div>`);
  $("#os").addEventListener("submit", (e) => { e.preventDefault(); draw($("#oq").value); });
  draw();
}

async function attendeesTab(el, d) {
  const url = `${base()}/events/${d.event.id}/attendees`;
  let q = "", page = 1;
  render(el, html`<div class="row between"><p class="muted mb-0" id="att-sum">${spinner()}</p>
    <a class="btn btn-ghost btn-sm" href="${url}?format=csv" download>Export CSV</a></div>
    <p class="tiny muted">Attendee details are personal information. Use them only to run this event (POPIA). Exports are logged.</p>
    <form class="row" id="att-s" role="search"><label class="sr-only" for="att-q">Search attendees</label><input id="att-q" type="search" placeholder="Name, ticket code, order or email"><button class="btn btn-ghost">Search</button></form>
    <div id="att-list" class="mt"></div>`);
  async function draw() {
    const r = await get(`${url}?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const list = r.attendees;
    const total = r.total ?? list.length;
    const checkedIn = r.checkedIn ?? list.filter((a) => a.status === "used").length;
    $("#att-sum").textContent = `${total.toLocaleString("en-ZA")} ticket${total === 1 ? "" : "s"} · ${checkedIn.toLocaleString("en-ZA")} checked in`;
    render($("#att-list"), html`${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Holder</th><th>Ticket</th><th>Code</th><th>Order</th><th>Status</th><th>Checked in</th></tr></thead><tbody>
      ${list.map((a) => html`<tr><td>${a.holder_name || "—"}</td><td>${a.ticket_type}</td><td class="mono">${a.code}</td><td class="mono">${a.reference}</td><td>${badge(a.status)}</td><td>${a.admitted_at ? fmtTime(a.admitted_at) : ""}</td></tr>`)}</tbody></table></div>` : empty(q ? "No tickets match that search." : "No attendees yet.")}
      ${page > 1 || r.more ? html`<div class="row between mt"><button class="btn btn-ghost btn-sm" data-pg="-1" ${raw(page > 1 ? "" : "disabled")}>Previous</button><span class="small muted">Page ${page}</span><button class="btn btn-ghost btn-sm" data-pg="1" ${raw(r.more ? "" : "disabled")}>Next</button></div>` : ""}`);
    $("#att-list").querySelectorAll("[data-pg]").forEach((b) => b.addEventListener("click", () => { page += Number(b.dataset.pg); draw(); }));
  }
  $("#att-s").addEventListener("submit", (e) => { e.preventDefault(); q = $("#att-q").value.trim(); page = 1; draw(); });
  await draw();
}

async function staffTab(el, d, reload) {
  const { staff } = await get(`${base()}/events/${d.event.id}/staff`);
  render(el, html`<section class="card" aria-labelledby="live-h"><div class="card-title"><h3 id="live-h">Live check-ins</h3><span class="badge good" data-live>Live</span></div><div id="live">${spinner()}</div></section>
    <section class="card mt"><div class="card-title"><h3>Ticket scanners & desk staff</h3></div>
    <p class="small muted">Add your team by email. They scan tickets on their own phones at <strong>ticketroom.co.za/scan</strong>. There is no app to install, and they see a live count of people let in. They only see this event. New people get an email invite to set a password.</p>
    ${staff.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Scan tickets</th><th>Manage tags</th><th class="num">Admitted</th><th></th></tr></thead><tbody>
      ${staff.map((s) => html`<tr><td>${s.full_name}<div class="small muted">${s.email}</div></td><td>${s.can_scan ? "Yes" : "No"}</td><td>${s.can_manage_tags ? "Yes" : "No"}</td><td class="num">${s.admitted}</td><td>${can("owner", "manager") ? html`<button class="btn btn-ghost btn-sm" data-rm="${s.id}">Remove</button>` : ""}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No scanners yet. Add your first one below.</p>`}
    ${can("owner", "manager") ? html`<form class="stack mt" id="sf"><div class="grid-2"><div class="field"><label for="sn">Name <span class="muted">(for new people)</span></label><input id="sn" name="fullName" maxlength="120" autocomplete="off"></div>
      <div class="field"><label for="se">Email</label><input id="se" name="email" type="email" required autocomplete="off"></div></div>
      <label class="check"><input type="checkbox" name="canScan" checked><span>Can scan tickets at the gate</span></label><label class="check" data-feature="tags"><input type="checkbox" name="canManageTags"><span>Can link, replace and block tags (registration desk)</span></label>
      <button class="btn btn-dark">Add scanner</button></form>` : ""}</section>`);
  if ($("#sf")) onSubmit($("#sf"), async (v) => {
    const r = await post(`${base()}/events/${d.event.id}/staff`, v);
    toast(r.invited ? `Invite emailed to ${v.email}. They can scan once they set a password.` : "Scanner added. They'll see this event at /scan.", "good");
    reload();
  });
  $$("[data-rm]", el).forEach((b) => b.addEventListener("click", async () => { await del(`${base()}/events/${d.event.id}/staff/${b.dataset.rm}`); reload(); }));

  const live = $("#live", el);
  const tick = async () => {
    if (!live.isConnected) return;
    try {
      const x = await get(`${base()}/events/${d.event.id}/checkins/live`);
      const pct = x.issued ? Math.round((x.admitted / x.issued) * 100) : 0;
      render(live, html`<div class="grid-3"><div class="kpi"><div class="k">Admitted</div><div class="v">${x.admitted}</div><div class="s">of ${x.issued} tickets (${pct}%)</div></div>
        <div class="kpi"><div class="k">Still to arrive</div><div class="v">${Math.max(0, x.issued - x.admitted)}</div><div class="s">valid tickets not yet scanned</div></div>
        <div class="kpi"><div class="k">Last 15 minutes</div><div class="v">${x.last15min}</div><div class="s">people admitted</div></div></div>
        <div class="meter mt" aria-hidden="true"><i data-pct="${pct}"></i></div>
        ${x.scanners.length ? html`<h4 class="mt">By scanner</h4><div class="table-wrap"><table><thead><tr><th>Scanner</th><th class="num">Admitted</th><th class="num">Refused</th><th>Last scan</th></tr></thead><tbody>${x.scanners.map((s) => html`<tr><td>${s.full_name}</td><td class="num">${s.admitted}</td><td class="num">${s.refused}</td><td>${fmtTime(s.last_scan)}</td></tr>`)}</tbody></table></div>` : html`<p class="small muted mt mb-0">No scans yet. Counts update every 5 seconds.</p>`}
        ${x.recent.length ? html`<h4 class="mt">Latest scans</h4><ul class="small">${x.recent.slice(0, 8).map((a) => html`<li>${fmtTime(a.occurred_at)} · ${badge(a.outcome)} ${a.holder_name || ""} <span class="muted">by ${a.scanner}${a.gate ? `, ${a.gate}` : ""}</span></li>`)}</ul>` : ""}
        <p class="tiny muted mb-0">Updated ${fmtTime(x.at)}</p>`);
      paintMeters(live);
      $("[data-live]", el)?.classList.replace("warn", "good");
    } catch { $("[data-live]", el)?.classList.replace("good", "warn"); }
    setTimeout(tick, document.hidden ? 15000 : 5000);
  };
  tick();
}

async function vendorsTab(el, d, reload) {
  const { vendors } = await get(`${base()}/events/${d.event.id}/vendors`);
  const edit = can("owner", "manager");
  render(el, html`${!d.event.cashless_enabled ? html`<p class="callout warn">Cashless is switched off for this event. Turn it on under Details to use vendors and POS.</p>` : ""}
    ${vendors.length ? html`<div class="stack">${vendors.map((v) => html`<section class="card"><div class="card-title"><div><h3>${v.name}</h3><span class="small muted">${v.description || ""} · commission ${(v.commission_bps / 100).toFixed(1)}% · gross ${moneyExact(v.gross_cents)}</span></div>
        <div class="row">${badge(v.status)}${edit ? html`<button class="btn btn-ghost btn-sm" data-vstatus="${v.id}" data-s="${v.status === "active" ? "suspended" : "active"}">${v.status === "active" ? "Suspend" : "Reactivate"}</button>` : ""}
        ${can("owner", "finance") ? html`<button class="btn btn-ghost btn-sm" data-vpay="${v.id}">Request settlement</button>` : ""}</div></div>
      <div class="grid-2"><div><div class="label">Team</div>${v.members.length ? html`<ul class="small">${v.members.map((m) => html`<li>${m.name} (${m.role}), ${m.email}</li>`)}</ul>` : html`<p class="small muted">No vendor staff yet.</p>`}
          ${edit ? html`<form class="row" data-member="${v.id}"><input name="email" type="email" required placeholder="Staff email" class="grow" aria-label="Vendor staff email"><select name="role" aria-label="Role"><option value="cashier">Cashier</option><option value="manager">Manager</option></select><button class="btn btn-ghost btn-sm">Add</button></form>` : ""}</div>
        <div><div class="label">Terminals</div>${v.terminals.length ? html`<ul class="small">${v.terminals.map((t) => html`<li>${t.label} ${badge(t.status)} ${t.lastSeenAt ? html`<span class="muted">seen ${fmtDateTime(t.lastSeenAt)}</span>` : ""} ${edit && t.status !== "retired" ? html`<button class="btn-link" data-tstatus="${t.id}" data-s="${t.status === "active" ? "suspended" : "active"}">${t.status === "active" ? "suspend" : "activate"}</button>` : ""}</li>`)}</ul>` : html`<p class="small muted">No terminals.</p>`}
          ${edit ? html`<form class="row" data-term="${v.id}"><input name="label" required placeholder="e.g. Till 1" class="grow" aria-label="Terminal name"><button class="btn btn-ghost btn-sm">Register terminal</button></form>` : ""}</div></div></section>`)}</div>` : empty("No vendors yet.")}
    ${edit ? html`<section class="card mt"><h3>Add vendor</h3><form class="stack" id="vf"><div class="grid-2"><div class="field"><label for="vn">Vendor name</label><input id="vn" name="name" required></div><div class="field"><label for="vc">Commission (%)</label><input id="vc" name="commission" inputmode="decimal" value="0"></div></div>
      <div class="field"><label for="vd">What they sell</label><input id="vd" name="description" maxlength="240"></div><button class="btn btn-dark">Add vendor</button></form></section>` : ""}`);
  if ($("#vf")) onSubmit($("#vf"), async (v) => { await post(`${base()}/events/${d.event.id}/vendors`, { name: v.name, description: v.description, commissionBps: Math.round(Number(v.commission || 0) * 100) }); toast("Vendor added.", "good"); reload(); });
  $$("[data-member]", el).forEach((f) => onSubmit(f, async (v) => { await post(`${base()}/events/${d.event.id}/vendors/${f.dataset.member}/members`, v); toast("Vendor staff added.", "good"); reload(); }));
  $$("[data-term]", el).forEach((f) => onSubmit(f, async (v) => {
    const r = await post(`${base()}/events/${d.event.id}/vendors/${f.dataset.term}/terminals`, v);
    dialog("Terminal registered", html`<p>Enter this key once on the POS device (<strong>ticketroom.co.za/pos</strong>). <strong>It is shown only now.</strong></p><input readonly class="mono small" value="${r.terminal.terminalKey}" aria-label="Terminal key"><p class="small muted mt">If it is lost or a device is stolen, suspend the terminal and register a new one.</p>`, { onClose: reload });
  }));
  $$("[data-vstatus]", el).forEach((b) => b.addEventListener("click", async () => { await patch(`${base()}/events/${d.event.id}/vendors/${b.dataset.vstatus}`, { status: b.dataset.s }); reload(); }));
  $$("[data-tstatus]", el).forEach((b) => b.addEventListener("click", async () => { await patch(`${base()}/events/${d.event.id}/terminals/${b.dataset.tstatus}`, { status: b.dataset.s }); reload(); }));
  $$("[data-vpay]", el).forEach((b) => b.addEventListener("click", async () => { try { const r = await post(`${base()}/events/${d.event.id}/vendors/${b.dataset.vpay}/payout`); toast(`Settlement ${r.payout.reference} requested for ${moneyExact(r.payout.amount_cents)}.`, "good"); } catch (err) { toast(err.message, "bad"); } }));
}

async function detailsTab(el, d, reload) {
  if (!can("owner", "manager")) return render(el, html`<p class="muted">You have view-only access.</p>`);
  render(el, html`<div class="card">${eventForm(d.event)}</div>`);
  const f = $("#evf"); wireUpload(f);
  onSubmit(f, async (v) => { await patch(`${base()}/events/${d.event.id}`, eventPayload(v)); toast("Saved.", "good"); reload(); });
}

// ---------------- marketing ----------------
async function marketing() {
  const [{ campaigns }, aud, evs] = await Promise.all([get(`${base()}/campaigns`), get(`${base()}/marketing/audience`), get(`${base()}/events`)]);
  const cfg = await get("/api/config");
  render(main, html`${head("Marketing", "Email the people who booked with you. Only those who ticked the box to hear from you are included. That is what POPIA requires, and it keeps people happy to read your mail.", can("owner", "manager", "marketing") ? html`<button class="btn btn-primary" data-new>New campaign</button>` : "")}
    ${pendingBanner()}
    <div class="kpis"><div class="kpi"><div class="k">Ticket holders</div><div class="v">${aud.ticketHolders}</div><div class="s">all your events</div></div>
      <div class="kpi"><div class="k">Email audience</div><div class="v">${aud.emailOptIns}</div><div class="s">opted in to your email</div></div>
      <div class="kpi" data-feature="sms"><div class="k">SMS audience</div><div class="v">${aud.smsOptIns}</div><div class="s">opted in, with a mobile number</div></div>
      <div class="kpi"><div class="k">Campaigns sent</div><div class="v">${campaigns.filter((c) => c.status === "sent").length}</div><div class="s">limit 10 per day</div></div></div>
    ${cfg.messaging.email === "log" || cfg.messaging.sms === "log" ? html`<p class="callout warn mt"><strong>Delivery is simulated in this environment.</strong> Messages are queued and recorded but not sent until an email/SMS gateway is connected.</p>` : ""}
    <section class="card mt"><h2>Campaigns</h2>${campaigns.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Channel</th><th>Status</th><th class="num">Recipients</th><th class="num">Delivered</th><th>Date</th><th></th></tr></thead><tbody>
      ${campaigns.map((c) => html`<tr><td><strong>${c.name}</strong>${c.subject ? html`<div class="small muted">${c.subject}</div>` : ""}</td><td>${c.channel.toUpperCase()}</td><td>${badge(c.status)}</td><td class="num">${c.recipients_count}</td><td class="num">${c.delivered_count}</td>
        <td>${c.sent_at ? fmtDateTime(c.sent_at) : c.scheduled_at ? `Scheduled ${fmtDateTime(c.scheduled_at)}` : fmtDate(c.created_at)}</td><td>${["draft", "scheduled"].includes(c.status) ? html`<button class="btn btn-ghost btn-sm" data-open="${c.id}">Open</button>` : ""}</td></tr>`)}</tbody></table></div>` : empty("No campaigns yet.")}</section>`);
  const open = (c = null) => campaignDialog(c, evs, marketing);
  $("[data-new]")?.addEventListener("click", () => open());
  $$("[data-open]").forEach((b) => b.addEventListener("click", () => open(campaigns.find((c) => c.id === b.dataset.open))));
}

function campaignDialog(c, evs, done) {
  const dlg = dialog(c ? c.name : "New campaign", html`<form class="stack" id="cf">
    <div class="grid-2"><div class="field"><label for="cn">Campaign name (internal)</label><input id="cn" name="name" required value="${c?.name || ""}"></div>
      <div class="field"><label for="cc">Channel</label><select id="cc" name="channel" ${raw(c ? "disabled" : "")}><option value="email" ${raw(c?.channel === "email" ? "selected" : "")}>Email</option>${FEATURES.sms ? html`<option value="sms" ${raw(c?.channel === "sms" ? "selected" : "")}>SMS</option>` : ""}</select></div></div>
    <div class="field" id="subj"><label for="cs">Email subject</label><input id="cs" name="subject" maxlength="150" value="${c?.subject || ""}"></div>
    <div class="field"><label for="cb">Message</label><textarea id="cb" name="body" required maxlength="5000">${c?.body || ""}</textarea><span class="hint" id="cbh">Use {{first_name}} to personalise. An unsubscribe link and your organisation name are added automatically.</span></div>
    <fieldset class="field"><legend class="label">Audience: people who bought tickets to…</legend>
      <div class="stack">${evs.map((e) => html`<label class="check"><input type="checkbox" name="ev_${e.id}" ${raw(c?.audience?.eventIds?.includes(e.id) ? "checked" : "")}><span>${e.title} <span class="muted small">${fmtDate(e.starts_at)}</span></span></label>`)}</div><span class="hint">Leave all unticked to include every event.</span></fieldset>
    <div class="row"><button class="btn btn-dark" type="submit">Save draft</button></div></form>
    <div id="pv" class="mt"></div>`, { wide: true, onClose: done });
  const form = $("#cf", dlg);
  const sync = () => { const sms = form.elements.channel.value === "sms"; $("#subj", dlg).classList.toggle("hidden", sms); $("#cbh", dlg).textContent = sms ? `${form.elements.body.value.length}/300 characters. Your name and an opt-out link are added automatically.` : "Use {{first_name}} to personalise. An unsubscribe link and your organisation name are added automatically."; };
  form.elements.channel.addEventListener("change", sync); form.elements.body.addEventListener("input", sync); sync();
  let current = c;
  const payload = (v) => ({ name: v.name, channel: current?.channel || v.channel, subject: v.subject, body: v.body, eventIds: evs.filter((e) => v[`ev_${e.id}`]).map((e) => e.id) });
  const preview = async () => {
    const p = await get(`${base()}/campaigns/${current.id}/preview`);
    render($("#pv", dlg), html`<div class="card flat"><div class="card-title"><h3>Preview</h3><span class="small muted">${p.recipients} recipient${p.recipients === 1 ? "" : "s"}${p.segments ? ` · ${p.segments} SMS segment${p.segments === 1 ? "" : "s"} each · est. ${moneyExact(p.estimatedCostCents)}` : ""}</span></div>
      ${p.preview.subject ? html`<p><strong>${p.preview.subject}</strong></p>` : ""}<div class="prose small">${p.preview.body}</div>
      <div class="row mt"><button class="btn btn-ghost btn-sm" data-test>Send test to me</button><label class="sr-only" for="sat">Schedule for</label><input type="datetime-local" id="sat" class="grow"><button class="btn btn-ghost btn-sm" data-sched>Schedule</button><button class="btn btn-primary btn-sm" data-send>Send now</button></div></div>`);
    $("[data-test]", dlg).addEventListener("click", async () => { try { const r = await post(`${base()}/campaigns/${current.id}/test`); toast(`Test queued to ${r.sentTo}.`, "good"); } catch (err) { toast(err.message, "bad"); } });
    $("[data-send]", dlg).addEventListener("click", async () => {
      if (!(await confirmDialog("Send campaign?", `This sends to ${p.recipients} people now. It can't be recalled.`, { confirm: "Send now" }))) return;
      try { const r = await post(`${base()}/campaigns/${current.id}/send`, {}); toast(`Sent to ${r.campaign.recipients_count} recipients.`, "good"); dlg.close(); } catch (err) { toast(err.message, "bad"); }
    });
    $("[data-sched]", dlg).addEventListener("click", async () => {
      const at = $("#sat", dlg).value; if (!at) return toast("Pick a date and time.", "bad");
      try { await post(`${base()}/campaigns/${current.id}/send`, { scheduledAt: new Date(at).toISOString() }); toast("Scheduled.", "good"); dlg.close(); } catch (err) { toast(err.message, "bad"); }
    });
  };
  onSubmit(form, async (v) => {
    const body = payload(v);
    const r = current ? await patch(`${base()}/campaigns/${current.id}`, body) : await post(`${base()}/campaigns`, body);
    current = r.campaign; toast("Draft saved.", "good"); await preview();
  });
  if (c) preview();
}

// ---------------- refunds ----------------
async function refunds() {
  const { refunds: list } = await get(`${base()}/refunds`);
  render(main, html`${head("Refunds", "Ticket refunds are approved by TicketRoom finance. You can approve vendor (POS) refunds for your own events, but not ones you asked for yourself.")}
    ${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Event</th><th>Type</th><th>Reason</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((r) => html`<tr><td class="mono">${r.reference}</td><td>${r.event_title}${r.vendor_name ? html`<div class="small muted">${r.vendor_name}</div>` : ""}</td><td>${r.kind.replace("_", " ")}</td><td class="small">${r.reason}<div class="tiny muted">by ${r.requested_by_name || "system"}</div></td><td class="num">${moneyExact(r.amount_cents + r.fee_refund_cents)}</td><td>${badge(r.status)}</td>
        <td>${r.kind === "pos_sale" && r.status === "requested" && !r.mine && can("owner", "manager") ? html`<div class="row"><button class="btn btn-good btn-sm" data-dec="${r.id}" data-ok="1">Approve</button><button class="btn btn-ghost btn-sm" data-dec="${r.id}" data-ok="">Reject</button></div>` : ""}</td></tr>`)}</tbody></table></div>` : empty("No refunds.")}`);
  $$("[data-dec]").forEach((b) => b.addEventListener("click", async () => { try { await post(`${base()}/refunds/${b.dataset.dec}/decide`, { approve: !!b.dataset.ok }); toast("Done.", "good"); refunds(); } catch (err) { toast(err.message, "bad"); } }));
}

// ---------------- finance ----------------
async function finance() {
  if (!can("owner", "finance", "manager")) return render(main, html`${head("Finance")}<p class="muted">Your role can't view finance.</p>`);
  const f = await get(`${base()}/finance`);
  render(main, html`${head("Finance & payouts", `Revenue becomes available ${ORG.payoutHoldDays} day${ORG.payoutHoldDays === 1 ? "" : "s"} after each event ends, less refunds in progress.`)}
    <div class="kpis"><div class="kpi"><div class="k">Total owed to you</div><div class="v">${money(f.totalCents)}</div><div class="s">ticket revenue less refunds & payouts</div></div>
      <div class="kpi"><div class="k">Available now</div><div class="v">${money(f.availableCents)}</div><div class="s">can be paid out</div></div>
      <div class="kpi"><div class="k">Payouts in progress</div><div class="v">${money(f.inFlightCents)}</div><div class="s">awaiting approval / transfer</div></div>
      <div class="kpi"><div class="k">Refunds pending</div><div class="v">${money(f.pendingRefundsCents)}</div><div class="s">held back from payouts</div></div></div>
    <div class="grid-2 mt"><section class="card"><h2>Request a payout</h2>
      ${!ORG.bank?.last4 ? html`<p class="callout warn">Add your bank details in Settings first.</p>` : html`<p class="small muted">Paid by EFT to ${ORG.bank.bankName} ••••${ORG.bank.last4} after TicketRoom finance approves it.</p>`}
      ${can("owner", "finance") ? html`<form class="stack" id="po"><div class="field"><label for="pa">Amount (R)</label><input id="pa" name="amount" inputmode="decimal" required value="${f.availableCents ? (f.availableCents / 100).toFixed(2) : ""}"><span class="hint">Minimum R100.</span></div><button class="btn btn-primary" ${raw(!f.availableCents || !ORG.bank?.last4 ? "disabled" : "")}>Request payout</button></form>` : html`<p class="muted">Only owners and finance members can request payouts.</p>`}</section>
      <section class="card"><h2>By event</h2><div class="table-wrap"><table><thead><tr><th>Event</th><th>Ends</th><th class="num">Balance</th><th>Status</th></tr></thead><tbody>
        ${f.events.map((e) => html`<tr><td>${e.title}</td><td>${fmtDate(e.ends_at)}</td><td class="num">${moneyExact(e.balance_cents)}</td><td>${e.releasable ? badge("available") : e.status === "cancelled" ? badge("cancelled") : html`<span class="badge plain">on hold</span>`}</td></tr>`)}</tbody></table></div></section></div>
    <section class="card mt"><h2>Payout history</h2>${f.payouts.length ? html`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>For</th><th class="num">Amount</th><th>Status</th><th>Requested</th><th>Bank ref</th></tr></thead><tbody>
      ${f.payouts.map((p) => html`<tr><td class="mono">${p.reference}</td><td>${p.vendor_name ? `Vendor: ${p.vendor_name}` : "You"}</td><td class="num">${moneyExact(p.amount_cents)}</td><td>${badge(p.status)}</td><td>${fmtDate(p.created_at)}</td><td class="mono">${p.bank_reference || ""}</td></tr>`)}</tbody></table></div>` : html`<p class="muted mb-0">No payouts yet.</p>`}</section>`);
  if ($("#po")) onSubmit($("#po"), async (v) => { const c = parseRand(v.amount); const r = await post(`${base()}/payouts`, { amountCents: c }); toast(`Payout ${r.payout.reference} requested.`, "good"); finance(); });
}

// ---------------- team & settings ----------------
async function team() {
  const { members } = await get(`${base()}/members`);
  render(main, html`${head("Team", "Give colleagues their own login with only the access they need.")}
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>${members.map((m) => html`<tr><td>${m.full_name}</td><td>${m.email}</td><td>${m.role}</td><td>${can("owner") && m.role !== "owner" ? html`<button class="btn btn-ghost btn-sm" data-rm="${m.id}">Remove</button>` : ""}</td></tr>`)}</tbody></table></div>
    ${can("owner") ? html`<section class="card mt"><h3>Add a team member</h3><form class="stack" id="tm"><div class="grid-2"><div class="field"><label for="me">Their TicketRoom email</label><input id="me" name="email" type="email" required></div>
      <div class="field"><label for="mr">Role</label><select id="mr" name="role"><option value="manager">Manager: events, staff, vendors</option><option value="marketing">Marketing: campaigns, promos</option><option value="finance">Finance: payouts, refunds</option><option value="viewer">Viewer: read only</option></select></div></div><button class="btn btn-dark">Add</button></form></section>` : ""}`);
  if ($("#tm")) onSubmit($("#tm"), async (v) => { await post(`${base()}/members`, v); toast("Added.", "good"); team(); });
  $$("[data-rm]").forEach((b) => b.addEventListener("click", async () => { await del(`${base()}/members/${b.dataset.rm}`); team(); }));
}

async function settings() {
  const { organiser: o } = await get(`${base()}`);
  render(main, html`${head("Settings")}<div class="grid-2">
    <section class="card"><h2>Organisation</h2><form class="stack" id="of">
      <div class="field"><label for="on">Name</label><input id="on" name="name" required value="${o.name}"></div>
      <div class="field"><label for="oe">Contact email</label><input id="oe" name="contactEmail" type="email" required value="${o.contactEmail}"></div>
      <div class="field"><label for="op">Contact number</label><input id="op" name="contactPhone" value="${o.contactPhone || ""}"></div>
      <div class="field"><label for="od">About</label><textarea id="od" name="description">${o.description || ""}</textarea></div>
      <button class="btn btn-dark" ${raw(can("owner", "manager") ? "" : "disabled")}>Save</button></form></section>
    <section class="card"><h2>Bank details for payouts</h2>${o.bank ? html`
      ${o.bank.last4 ? html`<p class="small">Current: ${o.bank.bankName} · ${o.bank.accountHolder} · ••••${o.bank.last4} · branch ${o.bank.branchCode}</p>` : ""}
      <form class="stack" id="bf"><div class="field"><label for="bn">Bank</label><select id="bn" name="bankName">${["ABSA", "African Bank", "Capitec", "Discovery Bank", "FNB", "Investec", "Nedbank", "Standard Bank", "TymeBank", "Other"].map((b) => html`<option ${raw(b === o.bank.bankName ? "selected" : "")}>${b}</option>`)}</select></div>
        <div class="field"><label for="bh">Account holder</label><input id="bh" name="accountHolder" required value="${o.bank.accountHolder || ""}"></div>
        <div class="grid-2"><div class="field"><label for="ba">Account number</label><input id="ba" name="accountNumber" inputmode="numeric" required autocomplete="off"></div><div class="field"><label for="bb">Branch code</label><input id="bb" name="branchCode" inputmode="numeric" required value="${o.bank.branchCode || ""}"></div></div>
        <button class="btn btn-dark">Save bank details</button><p class="tiny muted mb-0">Stored encrypted. Changes are logged and may delay a pending payout while we verify them.</p></form>` : html`<p class="muted">Only owners and finance members can see bank details.</p>`}</section></div>`);
  onSubmit($("#of"), async (v) => { await patch(`${base()}`, v); toast("Saved.", "good"); });
  if ($("#bf")) onSubmit($("#bf"), async (v, f) => { await put(`${base()}/bank`, v); toast("Bank details saved.", "good"); f.elements.accountNumber.value = ""; await loadOrg(); settings(); });
}

async function loadOrg() {
  ORGS = (await get("/api/organiser/orgs")).organisers;
  const want = localStorage.getItem("tr_org");
  const pick = ORGS.find((o) => o.id === want) || ORGS[0];
  ORG = pick ? (await get(`/api/organiser/${pick.id}`)).organiser : null;
}

(async () => {
  await header($("#header"), { portal: "organiser" });
  const u = await requireUser("Sign in to the organiser portal.");
  if (!u) return render(main, empty("Sign in to continue."));
  await header($("#header"), { portal: "organiser" });
  FEATURES = await features();
  await loadOrg();
  nav();
  if (!ORG) { render($("#sidenav"), ""); return apply(); }
  router([
    ["/", dashboard], ["/apply", apply], ["/events", events], ["/events/new", newEvent], ["/events/:id", (p) => eventWorkspace(p)], ["/events/:id/:tab", (p) => eventWorkspace(p)],
    ["/marketing", marketing], ["/refunds", gate("finance", refunds)], ["/finance", gate("finance", finance)], ["/team", team], ["/settings", settings],
  ], () => { location.hash = "#/"; });
})();
