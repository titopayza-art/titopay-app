// TicketRoom back office. The server enforces every permission; the UI only
// hides what a role cannot do.
import { html, raw, render, $, $$, get, post, put, patch, del, api, money, moneyExact, fmtDate, fmtDateTime, header, requireUser, toast, onSubmit, badge, empty, spinner, dialog, confirmDialog, router, roles, me, gate, matchPasswords, qrPanel, ApiError } from "/assets/core.js";

const main = $("#main");
let R = new Set();
const isA = () => R.has("admin"), isF = () => R.has("finance"), isS = () => R.has("support");
const head = (t, s = "", a = "") => html`<div class="page-head"><div><h1>${t}</h1>${s ? html`<p class="muted">${s}</p>` : ""}</div><div class="row">${a}</div></div>`;
const tbl = (cols, rows, none = "Nothing here yet.") => rows.length ? html`<div class="table-wrap"><table><thead><tr>${cols.map((c) => html`<th class="${c.startsWith("#") ? "num" : ""}">${c.replace("#", "")}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>` : empty(none);
// People who subscribed to TicketRoom updates on the website, and updates sent to them.
async function subscribers(params, q = "") {
  const d = await get(`/api/admin/subscribers${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const n = d.counts.subscribed;
  render(main, html`${head("Subscribers", "People who asked for TicketRoom updates from the website. Each confirmed their email address first, and every update carries an unsubscribe link.",
      html`<a class="btn btn-ghost" href="/api/admin/subscribers?format=csv" download>Export CSV</a>`)}
    <div class="kpis"><div class="kpi"><div class="k">Subscribed</div><div class="v">${n.toLocaleString("en-ZA")}</div><div class="s">confirmed</div></div>
      <div class="kpi"><div class="k">Waiting</div><div class="v">${d.counts.pending.toLocaleString("en-ZA")}</div><div class="s">haven't clicked the email yet</div></div>
      <div class="kpi"><div class="k">Unsubscribed</div><div class="v">${d.counts.unsubscribed.toLocaleString("en-ZA")}</div><div class="s">never emailed again</div></div></div>
    ${isA() ? html`<section class="card stack mt"><h2>Send an update</h2>
      <form class="stack" id="nl"><div class="field"><label for="nl-s">Subject</label><input id="nl-s" name="subject" required maxlength="150" placeholder="New this month on TicketRoom"></div>
        <div class="field"><label for="nl-m">Message</label><textarea id="nl-m" name="message" required rows="9" maxlength="10000" placeholder="Hi there,&#10;&#10;Here's what's new…"></textarea>
          <span class="hint">Plain text. A line like "See what's on: https://ticketroom.co.za" becomes a button. The unsubscribe line and company details are added for you.</span></div>
        <div class="row"><button type="button" class="btn btn-ghost" data-test>Send me a test</button><button class="btn btn-primary" ${raw(n ? "" : "disabled")}>Send to ${n.toLocaleString("en-ZA")} subscriber${n === 1 ? "" : "s"}</button></div></form></section>` : ""}
    ${d.issues.length ? html`<section class="mt"><h2>Updates sent</h2>${tbl(["Sent", "Subject", "#Recipients", "By"], d.issues.map((i) => html`<tr><td class="small">${fmtDateTime(i.created_at)}</td><td>${i.subject}</td><td class="num">${i.recipients}</td><td class="small">${i.sent_by}</td></tr>`))}</section>` : ""}
    <section class="mt"><div class="row between"><h2 class="mb-0">People</h2><form class="row" id="sq"><label class="sr-only" for="sq-in">Search subscribers</label><input id="sq-in" placeholder="Search email" value="${q}"><button class="btn btn-ghost">Search</button></form></div>
      <div class="mt">${tbl(["Email", "Status", "Signed up", "Confirmed"], d.subscribers.map((s) => html`<tr><td class="small">${s.email}</td><td>${badge(s.status)}</td><td class="small">${fmtDate(s.created_at)}</td><td class="small">${s.confirmed_at ? fmtDate(s.confirmed_at) : ""}</td></tr>`),
        q ? "Nobody matches that search." : "No one has subscribed yet. The sign-up form is at the bottom of every page on the website.")}</div></section>`);
  $("#sq").addEventListener("submit", (e) => { e.preventDefault(); subscribers(params, $("#sq-in").value.trim()); });
  const f = $("#nl");
  if (!f) return;
  const values = () => ({ subject: f.subject.value.trim(), message: f.message.value.trim() });
  $("[data-test]", f).addEventListener("click", async () => {
    if (!f.reportValidity()) return;
    await act(() => post("/api/admin/subscribers/send", { ...values(), test: true }), "Test sent to your email address.");
  });
  onSubmit(f, async () => {
    if (!(await confirmDialog(`Send this update to ${n.toLocaleString("en-ZA")} subscriber${n === 1 ? "" : "s"}?`, "It goes out straight away and can't be recalled. Send yourself a test first if you haven't.", { confirm: "Send update" }))) return;
    const r = await post("/api/admin/subscribers/send", { ...values(), test: false });
    toast(`Update on its way to ${r.recipients.toLocaleString("en-ZA")} subscriber${r.recipients === 1 ? "" : "s"}.`, "good");
    subscribers(params);
  });
}

// QR code maker: links, event pages, WhatsApp, email, phone or plain text,
// in TicketRoom colours or your own, as PNG (with an optional caption) or SVG.
async function qrStudio() {
  const { events } = await get("/api/admin/events?status=published").catch(() => ({ events: [] }));
  const site = location.origin;
  const KINDS = [["link", "Website link"], ["event", "Event page"], ["whatsapp", "WhatsApp chat"], ["email", "Email"], ["phone", "Phone call"], ["text", "Plain text"]];
  render(main, html`${head("QR codes", "Make a QR code for a poster, flyer, banner or slide. Download it as a PNG to share or print, or as an SVG for designers.")}
    <div class="qr-studio"><section class="card stack"><form class="stack" id="qf">
      <div class="field"><label for="qk">What should it open?</label><select id="qk" name="kind">${KINDS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div>
      <div data-inputs></div>
      <div class="field"><label for="qc">Caption under the code <span class="muted">(optional, PNG only)</span></label><input id="qc" name="caption" maxlength="60" placeholder="Scan for tickets"></div>
      <div class="qr-colours"><div class="field"><label for="qd">Squares</label><input id="qd" name="dark" type="color" value="#0b1a33"></div>
        <div class="field"><label for="ql">Background</label><input id="ql" name="light" type="color" value="#ffffff"></div>
        <div class="field"><label for="qe">Strength</label><select id="qe" name="ecc"><option value="M">Standard</option><option value="Q">Strong</option><option value="H">Extra strong (for print that may get scuffed)</option></select></div></div>
      <button class="btn btn-primary">Make QR code</button></form></section>
      <section class="card stack" aria-live="polite"><h2>Preview</h2><div data-out><p class="muted mb-0">Fill in the form and press <strong>Make QR code</strong>.</p></div></section></div>`);
  const f = $("#qf");
  const inputs = () => {
    const k = f.kind.value;
    const box = $("[data-inputs]", f);
    if (k === "link") render(box, html`<div class="field"><label for="qv">Web address</label><input id="qv" name="value" type="url" required placeholder="https://ticketroom.co.za" value="https://ticketroom.co.za"></div>`);
    else if (k === "event") render(box, events.length ? html`<div class="field"><label for="qv">Event</label><select id="qv" name="value">${events.map((e) => html`<option value="${e.slug}">${e.title} (${fmtDate(e.starts_at)})</option>`)}</select><span class="hint">Only published events have a page people can open.</span></div>`
      : html`<p class="callout warn mb-0">There are no published events yet. Choose "Website link" instead, or publish an event first.</p>`);
    else if (k === "whatsapp") render(box, html`<div class="grid-2"><div class="field"><label for="qv">WhatsApp number</label><input id="qv" name="value" type="tel" required placeholder="076 884 7372"></div>
      <div class="field"><label for="qm">First message <span class="muted">(optional)</span></label><input id="qm" name="message" maxlength="200" placeholder="Hi TicketRoom"></div></div>`);
    else if (k === "email") render(box, html`<div class="grid-2"><div class="field"><label for="qv">Email address</label><input id="qv" name="value" type="email" required value="hello@ticketroom.co.za"></div>
      <div class="field"><label for="qm">Subject <span class="muted">(optional)</span></label><input id="qm" name="message" maxlength="120"></div></div>`);
    else if (k === "phone") render(box, html`<div class="field"><label for="qv">Phone number</label><input id="qv" name="value" type="tel" required placeholder="076 884 7372"></div>`);
    else render(box, html`<div class="field"><label for="qv">Text</label><textarea id="qv" name="value" required maxlength="1000" rows="4"></textarea><span class="hint">Shown as text on the phone that scans it.</span></div>`);
  };
  // South African numbers: 076 884 7372 becomes 27768847372.
  const intl = (n) => { const d = String(n).replace(/[^0-9+]/g, "").replace(/^\+/, ""); return d.startsWith("0") ? `27${d.slice(1)}` : d; };
  const content = () => {
    const k = f.kind.value, v = (f.value?.value || "").trim(), m = (f.message?.value || "").trim();
    if (!v) throw new Error("Fill in what the code should open.");
    if (k === "link") { if (!/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(v)) throw new Error("Enter a full web address, starting with https://"); return { text: v, name: v.replace(/^https?:\/\//, "") }; }
    if (k === "event") return { text: `${site}/events/${v}`, name: v };
    if (k === "whatsapp") { const n = intl(v); if (!/^[1-9][0-9]{7,14}$/.test(n)) throw new Error("Enter a valid phone number."); return { text: `https://wa.me/${n}${m ? `?text=${encodeURIComponent(m)}` : ""}`, name: `whatsapp-${n}` }; }
    if (k === "email") { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error("Enter a valid email address."); return { text: `mailto:${v}${m ? `?subject=${encodeURIComponent(m)}` : ""}`, name: `email-${v}` }; }
    if (k === "phone") { const n = intl(v); if (!/^[1-9][0-9]{7,14}$/.test(n)) throw new Error("Enter a valid phone number."); return { text: `tel:+${n}`, name: `call-${n}` }; }
    return { text: v, name: "text" };
  };
  f.kind.addEventListener("change", inputs);
  inputs();
  onSubmit(f, async () => {
    let c;
    try { c = content(); } catch (err) { toast(err.message, "bad"); return; }
    const r = await post("/api/admin/qr", { text: c.text, dark: f.dark.value, light: f.light.value, ecc: f.ecc.value });
    const out = $("[data-out]");
    render(out, html`<p class="small mb-0">Opens: <span class="mono">${c.text}</span></p>`);
    out.append(qrPanel(r.svg, { name: `ticketroom-qr-${c.name}`, caption: f.caption.value.trim(), background: f.light.value, ink: f.dark.value }));
    out.insertAdjacentHTML("beforeend", '<p class="tiny muted mb-0">Test it with your phone camera before you print.</p>');
  });
}

// The TicketRoom team: who can use the admin portal, and what each may do.
const ROLE_INFO = [
  ["admin", "Admin", "Runs the platform: approves organisers and events, site settings, staff and roles."],
  ["finance", "Finance", "Approves refunds and payouts, reconciliation and the ledger."],
  ["support", "Support", "Helps customers: looks up orders and tickets, handles callbacks and support cases."],
];
async function staffPage() {
  const { staff } = await get("/api/admin/staff");
  const meId = (await me()).id;
  const roleBoxes = (prefix, has = []) => html`<fieldset class="stack card flat"><legend class="label">Roles</legend>${ROLE_INFO.map(([k, name, what]) => html`<label class="check"><input type="checkbox" name="${prefix}${k}" ${raw(has.includes(k) ? "checked" : "")}><span><strong>${name}</strong><br><span class="small muted">${what}</span></span></label>`)}</fieldset>`;
  render(main, html`${head("Staff & roles", "Everyone who can open the admin portal. Give each person only the roles they need.")}
    ${isA() ? html`<section class="card stack"><h2>Add a staff member</h2>
      <form class="stack" id="sf"><div class="grid-2"><div class="field"><label for="sn">Full name</label><input id="sn" name="fullName" required maxlength="120"></div>
        <div class="field"><label for="se">Email</label><input id="se" name="email" type="email" required><span class="hint">Someone new gets an email to set their password. An existing account just gets the roles.</span></div></div>
        ${roleBoxes("r_", ["support"])}<button class="btn btn-primary">Add to the team</button></form></section>` : ""}
    <section class="mt"><h2>The team</h2>${tbl(["Name", "Email", "Roles", ""], staff.map((s) => html`<tr><td>${s.full_name}${s.id === meId ? html` <span class="tiny muted">(you)</span>` : ""}</td><td class="small">${s.email}</td>
      <td>${s.roles.map((r) => html`<span class="badge ${r === "admin" ? "bad" : r === "finance" ? "info" : "good"}">${(ROLE_INFO.find(([k]) => k === r) || [, r])[1]}</span> `)}</td>
      <td>${isA() && s.id !== meId ? html`<button class="btn btn-ghost btn-sm" data-edit="${s.id}">Change roles</button>` : ""}</td></tr>`), "No staff yet.")}</section>`);
  const f = $("#sf");
  if (f) onSubmit(f, async (v) => {
    const roles = ROLE_INFO.map(([k]) => k).filter((k) => v[`r_${k}`]);
    if (!roles.length) throw new ApiError(422, { error: { message: "Tick at least one role." } });
    const r = await post("/api/admin/staff", { fullName: v.fullName, email: v.email, roles });
    toast(r.invited ? `Added. ${v.email} will get an email to set a password.` : `Added. ${v.email} can sign in with their usual password.`, "good");
    staffPage();
  });
  $$("[data-edit]").forEach((b) => b.addEventListener("click", () => {
    const s = staff.find((x) => x.id === b.dataset.edit);
    const d = dialog(`Roles for ${s.full_name}`, html`<form class="stack" id="rf">${roleBoxes("e_", s.roles)}
      <p class="tiny muted mb-0">Untick everything to remove ${s.full_name} from the team. They are signed out straight away.</p>
      <div class="row"><button class="btn btn-primary">Save roles</button></div></form>`);
    onSubmit($("#rf", d), async (v) => {
      const roles = ROLE_INFO.map(([k]) => k).filter((k) => v[`e_${k}`]);
      if (!roles.length && !(await confirmDialog(`Remove ${s.full_name} from the team?`, "They lose access to the admin portal and are signed out.", { confirm: "Remove", danger: true }))) return;
      await put(`/api/admin/staff/${s.id}`, { roles });
      d.close(); toast(roles.length ? "Roles saved." : `${s.full_name} has been removed from the team.`, "good"); staffPage();
    });
  }));
}

// Staff change their own password here, inside the admin portal.
async function myPassword() {
  const u = await me(true);
  render(main, html`${head("My password", `Signed in as ${u.email}. Other devices are signed out when you change it.`)}
    <section class="card" style="max-width:520px"><form class="stack" id="pw">
      <div class="field"><label for="cp">Current password</label><input id="cp" name="currentPassword" type="password" required autocomplete="current-password"></div>
      <div class="field"><label for="np">New password</label><input id="np" name="newPassword" type="password" required minlength="10" autocomplete="new-password"><span class="hint">At least 10 characters.</span></div>
      <div class="field"><label for="np2">Confirm new password</label><input id="np2" name="newPasswordConfirm" type="password" required minlength="10" autocomplete="new-password"></div>
      <button class="btn btn-dark">Change password</button></form></section>`);
  onSubmit($("#pw"), async (v, f) => { await post("/api/auth/me/password", matchPasswords(v, "newPassword", "newPasswordConfirm")); f.reset(); $(".pw-nag")?.remove(); toast("Password changed.", "good"); });
}
const act = async (fn, msg = "Done.") => { try { await fn(); toast(msg, "good"); return true; } catch (err) { toast(err.message, "bad"); return false; } };
const reason = (title, msg, label = "Reason") => confirmDialog(title, msg, { confirm: "Confirm", input: { label, required: true } });

function nav(counts = {}) {
  const c = (n) => (n ? html`<span class="count">${n}</span>` : "");
  render($("#sidenav"), html`<a href="#/">Overview</a>
    <div class="sect">Operations</div><a href="#/organisers">Organiser accounts${c(counts.orgs)}</a><a href="#/events">All events${c(counts.events)}</a><a href="#/users">All users</a><a href="#/lookup">Orders & tickets</a><a href="#/tags" data-feature="tags">Tags</a><a href="#/terminals" data-feature="pos">Terminals</a><a href="#/support">Support${c(counts.support)}</a>
    <div class="sect" data-feature="finance">Finance</div><a href="#/refunds" data-feature="finance">Refunds${c(counts.refunds)}</a><a href="#/payouts" data-feature="finance">Payouts${c(counts.payouts)}</a><a href="#/payments" data-feature="finance">Payments & webhooks</a><a href="#/reconciliation" data-feature="finance">Reconciliation${c(counts.recon)}</a><a href="#/ledger" data-feature="finance">Ledger</a>
    <div class="sect">Website</div><a href="#/site">Site settings</a><a href="#/posters">Advertising posters</a><a href="#/subscribers">Subscribers</a><a href="#/qr">QR codes</a><a href="#/assistant">Assistant</a><a href="#/emails">Email templates</a>
    <div class="sect">Governance</div><a href="#/integrations">Integrations</a><a href="#/audit">Audit log</a><a href="#/outbox">Messages</a>
    <div class="sect">You</div><a href="#/staff">Staff & roles</a><a href="#/password">My password</a>`);
}

async function overview() {
  const d = await get("/api/admin/dashboard");
  nav({ orgs: d.organisers.pending, events: d.events.pending + d.events.cancel_requests, refunds: d.ops.refunds_pending, payouts: d.ops.payouts_open, recon: d.ops.recon_exceptions, support: d.ops.support_open });
  const alert = (n, text, href, kind = "warn") => n ? html`<a class="callout ${kind} row between" href="${href}"><span><strong>${n}</strong> ${text}</span><span>→</span></a>` : "";
  render(main, html`${head("Overview", `Signed in as ${[...R].join(", ")}.`)}
    <div class="kpis"><div class="kpi"><div class="k">GMV (24h)</div><div class="v">${money(d.sales.gmv24)}</div><div class="s">${d.sales.orders24} orders</div></div>
      <div class="kpi"><div class="k">GMV (all time)</div><div class="v">${money(d.sales.gmv_all)}</div></div>
      <div class="kpi"><div class="k">Users</div><div class="v">${d.users.total}</div><div class="s">+${d.users.new7} this week</div></div>
      <div class="kpi"><div class="k">Live events</div><div class="v">${d.events.live}</div><div class="s">${d.organisers.approved} approved organisers</div></div></div>
    <section class="card mt"><h2>Needs attention</h2><div class="stack">
      ${alert(d.organisers.pending, "organisers awaiting approval", "#/organisers")}
      ${alert(d.events.pending, "events awaiting approval", "#/events")}
      ${alert(d.events.cancel_requests, "event cancellation requests", "#/events")}
      ${alert(d.ops.refunds_pending, "refunds awaiting finance approval", "#/refunds")}
      ${alert(d.ops.refunds_failed, "refunds failed at the provider", "#/refunds", "bad")}
      ${alert(d.ops.payouts_open, "payouts open", "#/payouts")}
      ${alert(d.ops.unfulfilled, "paid orders without tickets (refund raised)", "#/lookup", "bad")}
      ${alert(d.ops.webhook_problems, "webhook failures / rejections in 24h", "#/payments", "bad")}
      ${alert(d.ops.stale_payments, "payments pending for more than 30 minutes. Check them with the provider", "#/payments")}
      ${alert(d.ops.recon_exceptions, "unresolved reconciliation exceptions", "#/reconciliation", "bad")}
      ${alert(d.ops.messages_failed, "messages failed to send", "#/outbox", "bad")}
      ${alert(d.ops.support_open, "open support cases", "#/support")}
      ${Object.values(d.ops).every((x) => !x) && !d.organisers.pending && !d.events.pending ? html`<p class="callout good mb-0">All clear.</p>` : ""}</div></section>
    <section class="card mt"><h2>Ledger integrity</h2><p class="${d.ledger.balanced ? "callout good" : "callout bad"}">${d.ledger.balanced ? `Balanced: ${d.ledger.entries} entries sum to R0.00.` : `UNBALANCED. Investigate journals ${d.ledger.unbalancedJournals.join(", ")}`}</p>
      ${tbl(["Provider clearing", "#Ledger", "#Expected", "Check"], d.ledger.clearing.map((c) => html`<tr><td class="mono">${c.account}</td><td class="num">${moneyExact(c.ledgerCents)}</td><td class="num">${moneyExact(c.expectedCents)}</td><td>${badge(c.ok ? "matched" : "failed")}</td></tr>`))}</section>`);
}

async function organisers() {
  const { organisers: list } = await get("/api/admin/organisers");
  render(main, html`${head("Organiser accounts", "Organisations that sell tickets on TicketRoom. Approve applications here; organisers run their own events in the organiser portal.")}${tbl(["Organiser", "Owner", "Contact", "Events", "Bank", "Status", ""], list.map((o) => html`<tr><td><strong>${o.name}</strong><div class="tiny muted">${fmtDate(o.created_at)}</div></td><td>${o.owner_name || ""}</td><td class="small">${o.contact_email}<br>${o.contact_phone || ""}</td><td>${o.events}</td><td>${o.bank_account_last4 ? `••${o.bank_account_last4}` : "—"}</td><td>${badge(o.status)}<div class="tiny muted">${o.commission_bps == null ? "standard fee" : `fee ${o.commission_bps / 100}%`}</div></td>
    <td>${isA() ? html`<div class="row"><button class="btn btn-ghost btn-sm" data-fee="${o.id}">Fee</button>${o.status !== "approved" ? html`<button class="btn btn-good btn-sm" data-s="approved" data-id="${o.id}">Approve</button>` : ""}${o.status === "pending" ? html`<button class="btn btn-ghost btn-sm" data-s="rejected" data-id="${o.id}">Reject</button>` : ""}${o.status === "approved" ? html`<button class="btn btn-ghost btn-sm" data-s="suspended" data-id="${o.id}">Suspend</button>` : ""}</div>` : ""}</td></tr>`), "No organisers yet. When someone applies to sell tickets, their application appears here for approval.")}`);
  $$("[data-s]").forEach((b) => b.addEventListener("click", async () => {
    const why = b.dataset.s === "approved" ? "" : await reason(`${b.dataset.s === "rejected" ? "Reject" : "Suspend"} organiser`, b.dataset.s === "suspended" ? "Their published events will be suspended too." : "They will be told.");
    if (why === false) return;
    if (await act(() => post(`/api/admin/organisers/${b.dataset.id}/status`, { status: b.dataset.s, reason: why || undefined }))) organisers();
  }));
  $$("[data-fee]").forEach((b) => b.addEventListener("click", async () => {
    const v = await confirmDialog("Organiser commission", "Percentage of ticket sales charged to this organiser. Leave empty for the standard 5%. Applies to new orders only.", { confirm: "Save", input: { label: "Commission %", placeholder: "5" } });
    if (v === false) return;
    const pct = v === true || v === "" ? null : Number(String(v).replace(",", "."));
    if (pct !== null && !(pct >= 0 && pct <= 50)) return toast("Enter a percentage between 0 and 50.", "bad");
    if (await act(() => post(`/api/admin/organisers/${b.dataset.fee}/commission`, { commissionBps: pct === null ? undefined : Math.round(pct * 100) }), "Commission saved.")) organisers();
  }));
}

async function events() {
  const filter = sessionStorage.getItem("adm_ev") || "pending_approval";
  const { events: list } = await get(`/api/admin/events${filter === "all" ? "" : `?status=${filter}`}`);
  render(main, html`${head("All events", "Every event on TicketRoom, from every organiser. Approve, suspend or handle cancellation requests.")}<div class="chips">${[["pending_approval", "Awaiting approval"], ["cancel_requests", "Cancellation requests"], ["published", "Published"], ["suspended", "Suspended"], ["all", "All"]].map(([k, l]) => html`<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`)}</div>
    <div class="mt">${tbl(["Event", "Organiser", "Date", "Sold", "Status", ""], list.map((e) => html`<tr><td><strong>${e.title}</strong>${e.cancellation_requested_at && e.status !== "cancelled" ? html`<div class="small" >Cancellation requested: ${e.cancellation_reason}</div>` : ""}${e.featured ? html` <span class="badge amber plain">featured</span>` : ""}</td><td>${e.organiser_name}</td><td>${fmtDate(e.starts_at)}<div class="tiny muted">${e.city}</div></td><td>${e.sold}/${e.capacity}</td><td>${badge(e.status)}</td>
      <td>${isA() ? html`<div class="row">
        ${e.status === "pending_approval" ? html`<button class="btn btn-good btn-sm" data-a="publish" data-id="${e.id}">Publish</button><button class="btn btn-ghost btn-sm" data-a="reject" data-id="${e.id}">Request changes</button>` : ""}
        ${e.status === "published" ? html`<button class="btn btn-ghost btn-sm" data-a="${e.featured ? "unfeature" : "feature"}" data-id="${e.id}">${e.featured ? "Unfeature" : "Feature"}</button><button class="btn btn-ghost btn-sm" data-a="suspend" data-id="${e.id}">Suspend</button>` : ""}
        ${e.status === "suspended" ? html`<button class="btn btn-ghost btn-sm" data-a="reinstate" data-id="${e.id}">Reinstate</button>` : ""}
        ${!["cancelled", "completed", "draft"].includes(e.status) ? html`<button class="btn btn-danger btn-sm" data-cancel="${e.id}">Cancel & refund</button>` : ""}
        <a class="btn btn-link btn-sm" href="/events/${e.slug}" target="_blank">view</a></div>` : ""}</td></tr>`))}</div>`);
  $$("[data-f]").forEach((b) => b.addEventListener("click", () => { sessionStorage.setItem("adm_ev", b.dataset.f); events(); }));
  $$("[data-a]").forEach((b) => b.addEventListener("click", async () => {
    const needs = ["reject", "suspend"].includes(b.dataset.a);
    const why = needs ? await reason(b.dataset.a === "reject" ? "Request changes" : "Suspend event", "Tell the organiser why.") : "";
    if (why === false) return;
    if (await act(() => post(`/api/admin/events/${b.dataset.id}/status`, { action: b.dataset.a, reason: why || undefined }))) events();
  }));
  $$("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
    const why = await confirmDialog("Cancel event and refund everyone?", "Sales stop immediately. A full refund (including fees) is raised for every paid order; finance must approve them. This cannot be undone.", { confirm: "Cancel event", danger: true, input: { label: "Reason shown to buyers", required: true } });
    if (!why) return;
    try { const r = await post(`/api/admin/events/${b.dataset.cancel}/cancel`, { reason: why }); toast(`Event cancelled. ${r.refundsRaised} refunds raised for finance.`, "good"); events(); } catch (err) { toast(err.message, "bad"); }
  }));
}

async function users() {
  const draw = async (q = "") => {
    const { users: list } = await get(`/api/admin/users?q=${encodeURIComponent(q)}`);
    render($("#ul"), tbl(["Name", "Email", "Phone", "Roles", "Status", ""], list.map((u) => html`<tr><td>${u.full_name}</td><td>${u.email}${u.email_verified_at ? "" : html` <span class="tiny muted">(unverified)</span>`}</td><td>${u.phone || ""}</td><td>${u.roles.join(", ")}</td><td>${badge(u.status)}</td><td><button class="btn btn-ghost btn-sm" data-u="${u.id}">Open</button></td></tr>`)));
    $$("[data-u]").forEach((b) => b.addEventListener("click", () => userDialog(b.dataset.u, () => draw(q))));
  };
  render(main, html`${head("All users", "Everyone with a TicketRoom account: customers, organisers and staff.")}<form class="row" id="us"><input id="uq" class="grow" placeholder="Search name, email or phone" aria-label="Search users"><button class="btn btn-ghost">Search</button></form><div id="ul" class="mt">${spinner()}</div>`);
  $("#us").addEventListener("submit", (e) => { e.preventDefault(); draw($("#uq").value); });
  draw();
}

async function userDialog(id, done) {
  const d = await get(`/api/admin/users/${id}`);
  const u = d.user, has = (r) => d.roles.some((x) => x.role === r);
  const dlg = dialog(u.full_name, html`<p class="small">${u.email} · ${u.phone || "no phone"} · joined ${fmtDate(u.created_at)} · ${badge(u.status)} ${u.has_pin ? "· PIN set" : ""}</p>
    ${isA() ? html`<div class="row">${u.status === "active" ? html`<button class="btn btn-danger btn-sm" data-st="suspended">Suspend</button>` : u.status === "suspended" ? html`<button class="btn btn-good btn-sm" data-st="active">Reactivate</button>` : ""}
      ${["admin", "finance", "support"].map((r) => html`<button class="btn btn-ghost btn-sm" data-role="${r}" data-grant="${!has(r)}">${has(r) ? `Remove ${r}` : `Make ${r}`}</button>`)}</div>` : ""}
    <h3 class="mt">Orders</h3>${tbl(["Ref", "Event", "Status", "#Total"], d.orders.map((o) => html`<tr><td class="mono">${o.reference}</td><td>${o.title}</td><td>${badge(o.status)}</td><td class="num">${moneyExact(o.total_cents)}</td></tr>`))}
    <h3 class="mt">Tickets</h3>${tbl(["Code", "Event", "Status"], d.tickets.map((t) => html`<tr><td class="mono">${t.code}</td><td>${t.title}</td><td>${badge(t.status)}</td></tr>`))}
    <h3 class="mt">Tags</h3>${tbl(["Tag", "Type", "Event", "Status"], d.tags.map((t) => html`<tr><td class="mono">${t.display_code}</td><td>${t.tag_type}</td><td>${t.title || ""}</td><td>${badge(t.status)}</td></tr>`))}`, { wide: true, onClose: done });
  $$("[data-st]", dlg).forEach((b) => b.addEventListener("click", async () => { const why = await reason("Change account status", "This is logged."); if (why && await act(() => post(`/api/admin/users/${id}/status`, { status: b.dataset.st, reason: why }))) dlg.close(); }));
  $$("[data-role]", dlg).forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/users/${id}/roles`, { role: b.dataset.role, grant: b.dataset.grant === "true" }))) dlg.close(); }));
}

async function lookup() {
  render(main, html`${head("Orders & tickets")}<div class="grid-2"><form class="row card" id="ot"><label class="sr-only" for="tc">Ticket code</label><input id="tc" class="grow mono" placeholder="Ticket code"><button class="btn btn-dark">Find ticket</button></form>
    <form class="row card" id="oo"><label class="sr-only" for="oq">Order</label><input id="oq" class="grow" placeholder="Order ref or buyer email"><button class="btn btn-dark">Find orders</button></form></div><div id="res" class="mt"></div>`);
  $("#ot").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const { ticket: t, admissions } = await get(`/api/admin/tickets/${encodeURIComponent($("#tc").value.trim())}`);
      render($("#res"), html`<section class="card"><div class="card-title"><h2 class="mono">${t.code}</h2>${badge(t.status)}</div><dl class="dl"><dt>Event</dt><dd>${t.title}</dd><dt>Holder</dt><dd>${t.holder_name || ""}</dd><dt>Owner</dt><dd>${t.owner_email}</dd><dt>Order</dt><dd class="mono">${t.reference}</dd><dt>QR version</dt><dd>${t.qr_version}</dd>${t.revoked_reason ? html`<dt>Revoked</dt><dd>${t.revoked_reason}</dd>` : ""}</dl>
        ${t.status === "valid" && (isA() || isS()) ? html`<div class="row mt"><button class="btn btn-ghost btn-sm" data-reissue="${t.id}">Reissue QR</button>${isA() ? html`<button class="btn btn-danger btn-sm" data-revoke="${t.id}">Revoke</button>` : ""}</div>` : ""}
        <h3 class="mt">Scan history</h3>${tbl(["When", "Outcome", "Gate"], admissions.map((a) => html`<tr><td>${fmtDateTime(a.occurred_at)}</td><td>${badge(a.outcome)}</td><td>${a.gate || ""}</td></tr>`))}</section>`);
      $("[data-reissue]")?.addEventListener("click", async (ev) => { const why = await reason("Reissue QR", "The old QR stops working; the owner sees the new one in their wallet."); if (why) act(() => post(`/api/admin/tickets/${ev.target.dataset.reissue}/reissue`, { reason: why }), "New QR issued."); });
      $("[data-revoke]")?.addEventListener("click", async (ev) => { const why = await reason("Revoke ticket", "The ticket will no longer admit. This does not refund it."); if (why) act(() => post(`/api/admin/tickets/${ev.target.dataset.revoke}/revoke`, { reason: why }), "Revoked."); });
    } catch (err) { render($("#res"), empty(err.message)); }
  });
  $("#oo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { orders } = await get(`/api/admin/orders?q=${encodeURIComponent($("#oq").value.trim())}`);
    render($("#res"), tbl(["Ref", "Buyer", "Event", "#Total", "Status", "Payments"], orders.map((o) => html`<tr><td class="mono">${o.reference}</td><td>${o.buyer_name}<div class="tiny muted">${o.buyer_email}</div></td><td>${o.title}</td><td class="num">${moneyExact(o.total_cents)}</td><td>${badge(o.status)}</td>
      <td class="small">${(o.payments || []).map((p) => html`<div>${p.provider} <span class="mono">${p.ref || "—"}</span> ${badge(p.status)}</div>`)}</td></tr>`)));
  });
}

async function refunds() {
  const filter = sessionStorage.getItem("adm_rf") || "requested";
  const { refunds: list } = await get(`/api/admin/refunds${filter === "all" ? "" : `?status=${filter}`}`);
  const actionable = list.filter((r) => r.status === "requested" && !r.mine);
  render(main, html`${head("Refunds", "Every refund needs a second person: you cannot approve a refund you requested.", isF() && filter === "requested" && actionable.length ? html`<button class="btn btn-good" data-bulk>Approve all ${actionable.length} I can</button>` : "")}
    ${!isF() ? html`<p class="callout">View only. Approving refunds needs the finance role.</p>` : ""}
    <div class="chips">${["requested", "manual_pending", "failed", "completed", "rejected", "all"].map((k) => html`<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${k}</button>`)}</div>
    <div class="mt">${tbl(["Ref", "Event", "Type", "Reason", "By", "#Amount", "Status", ""], list.map((r) => html`<tr><td class="mono">${r.reference}${r.order_reference ? html`<div class="tiny muted">${r.order_reference}</div>` : ""}</td><td>${r.event_title}</td><td>${r.kind.replace("_", " ")}</td><td class="small">${r.reason}${r.failure_reason ? html`<div class="tiny">Failed: ${r.failure_reason}</div>` : ""}</td><td class="small">${r.requested_by_name || "system"}${r.decided_by_name ? html`<div class="tiny muted">decided: ${r.decided_by_name}</div>` : ""}</td>
      <td class="num">${moneyExact(r.amount_cents + r.fee_refund_cents)}</td><td>${badge(r.status)}</td>
      <td>${isF() && r.status === "requested" && !r.mine ? html`<div class="row"><button class="btn btn-good btn-sm" data-ok="${r.id}">Approve</button><button class="btn btn-ghost btn-sm" data-no="${r.id}">Reject</button></div>` : ""}
        ${isF() && r.status === "failed" ? html`<button class="btn btn-ghost btn-sm" data-retry="${r.id}">Retry</button>` : ""}${isF() && r.status === "manual_pending" ? html`<button class="btn btn-dark btn-sm" data-manual="${r.id}">Mark paid manually</button>` : ""}${r.mine && r.status === "requested" ? html`<span class="tiny muted">yours — needs someone else</span>` : ""}</td></tr>`))}</div>`);
  $$("[data-f]").forEach((b) => b.addEventListener("click", () => { sessionStorage.setItem("adm_rf", b.dataset.f); refunds(); }));
  $$("[data-ok]").forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/refunds/${b.dataset.ok}/decide`, { approve: true }), "Approved and processed.")) refunds(); }));
  $$("[data-no]").forEach((b) => b.addEventListener("click", async () => { const why = await reason("Reject refund", "The requester will see this note."); if (why && await act(() => post(`/api/admin/refunds/${b.dataset.no}/decide`, { approve: false, note: why }))) refunds(); }));
  $$("[data-retry]").forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/refunds/${b.dataset.retry}/retry`), "Retried.")) refunds(); }));
  $$("[data-manual]").forEach((b) => b.addEventListener("click", async () => {
    const ref = await reason("Complete refund manually", "Pay the customer by EFT or in the provider dashboard first, then enter its reference here.", "Payment reference");
    if (ref && await act(() => post(`/api/admin/refunds/${b.dataset.manual}/complete-manually`, { providerReference: ref }), "Refund marked as paid.")) refunds();
  }));
  $("[data-bulk]")?.addEventListener("click", async () => {
    if (!(await confirmDialog("Approve refunds", `Approve and process ${actionable.length} refunds?`, { confirm: "Approve all" }))) return;
    const r = await post("/api/admin/refunds/bulk-approve", { refundIds: actionable.map((x) => x.id) });
    toast(`${r.results.filter((x) => !x.error).length} processed, ${r.results.filter((x) => x.error).length} failed.`, "good"); refunds();
  });
}

async function payouts() {
  const { payouts: list } = await get("/api/admin/payouts");
  render(main, html`${head("Payouts", "TicketRoom does not move money automatically. Approve, make the EFT from TicketRoom's bank account, then record it here with the bank reference.")}
    ${tbl(["Ref", "Beneficiary", "Bank", "#Amount", "Requested", "Status", ""], list.map((p) => html`<tr><td class="mono">${p.reference}</td><td>${p.organiser_name}${p.vendor_name ? html`<div class="small">vendor: ${p.vendor_name}</div>` : ""}</td>
      <td class="small">${p.bank_name || "—"} ${p.bank_account_last4 ? `••${p.bank_account_last4}` : ""}<div class="tiny muted">${p.bank_account_holder || ""} ${p.bank_branch_code || ""}</div></td><td class="num">${moneyExact(p.amount_cents)}</td>
      <td class="small">${fmtDate(p.created_at)}<div class="tiny muted">${p.requested_by_name}${p.approved_by_name ? ` · approved ${p.approved_by_name}` : ""}</div></td><td>${badge(p.status)}${p.bank_reference ? html`<div class="tiny mono">${p.bank_reference}</div>` : ""}</td>
      <td>${isF() ? html`<div class="row">${p.status === "requested" && !p.mine ? html`<button class="btn btn-good btn-sm" data-ok="${p.id}">Approve</button><button class="btn btn-ghost btn-sm" data-no="${p.id}">Reject</button>` : ""}
        ${p.status === "approved" ? html`<button class="btn btn-ghost btn-sm" data-reveal="${p.id}">Show account no.</button><button class="btn btn-dark btn-sm" data-paid="${p.id}">Record EFT</button>` : ""}</div>` : ""}</td></tr>`))}`);
  $$("[data-ok]").forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/payouts/${b.dataset.ok}/decide`, { approve: true }))) payouts(); }));
  $$("[data-no]").forEach((b) => b.addEventListener("click", async () => { const why = await reason("Reject payout", "Tell the organiser why."); if (why && await act(() => post(`/api/admin/payouts/${b.dataset.no}/decide`, { approve: false, note: why }))) payouts(); }));
  $$("[data-reveal]").forEach((b) => b.addEventListener("click", async () => { try { const r = await post(`/api/admin/payouts/${b.dataset.reveal}/reveal-account`); dialog("Account number", html`<p class="mono">${r.accountNumber}</p><p class="tiny muted">This view was recorded in the audit log.</p>`); } catch (err) { toast(err.message, "bad"); } }));
  $$("[data-paid]").forEach((b) => b.addEventListener("click", async () => { const ref = await confirmDialog("Record EFT", "Only after the transfer has actually been made.", { confirm: "Record as paid", input: { label: "Bank transfer reference", required: true } }); if (ref && await act(() => post(`/api/admin/payouts/${b.dataset.paid}/mark-paid`, { bankReference: ref }))) payouts(); }));
}

async function payments() {
  const [{ payments: list }, { webhooks }] = await Promise.all([get("/api/admin/payments"), get("/api/admin/webhooks")]);
  render(main, html`${head("Payments & webhooks", "A payment is confirmed only by a verified provider webhook or a direct status check, never by the buyer's browser.")}
    <h2>Payments</h2>${tbl(["When", "Purpose", "User", "Provider ref", "#Amount", "Status", ""], list.map((p) => html`<tr><td class="small">${fmtDateTime(p.created_at)}</td><td>${p.purpose}</td><td class="small">${p.email}</td><td class="mono small">${p.provider_reference || "—"}</td><td class="num">${moneyExact(p.amount_cents)}${p.refunded_cents ? html`<div class="tiny">−${moneyExact(p.refunded_cents)}</div>` : ""}</td><td>${badge(p.status)}${p.failure_reason ? html`<div class="tiny muted">${p.failure_reason}</div>` : ""}</td>
      <td>${["pending", "cancelled", "failed"].includes(p.status) && p.provider_reference ? html`<button class="btn btn-ghost btn-sm" data-re="${p.id}">Re-check</button>` : ""}</td></tr>`))}
    <h2 class="mt-lg">Webhook deliveries</h2>${tbl(["Received", "Event id", "Signature", "Attempts", "Status", "Error"], webhooks.map((w) => html`<tr><td class="small">${fmtDateTime(w.received_at)}</td><td class="mono small">${w.provider_event_id}</td><td>${w.signature_valid ? "valid" : html`<span class="badge bad">invalid</span>`}</td><td>${w.attempts}</td><td>${badge(w.status)}</td><td class="small">${w.error || ""}</td></tr>`))}`);
  $$("[data-re]").forEach((b) => b.addEventListener("click", async () => { try { const r = await post(`/api/admin/payments/${b.dataset.re}/recheck`); toast(`Provider says: ${r.result}`, "good"); payments(); } catch (err) { toast(err.message, "bad"); } }));
}

async function reconciliation() {
  const { runs, ledger } = await get("/api/admin/reconciliation");
  const today = new Date(); const from = new Date(today.getTime() - 7 * 864e5);
  render(main, html`${head("Reconciliation", "Compare TicketRoom's records with the provider's report. Every difference needs a note before it is resolved. Nothing is corrected automatically.")}
    ${isF() ? html`<section class="card"><h2>New run</h2><form class="stack" id="rf"><div class="grid-3"><div class="field"><label for="rp">Provider</label><select id="rp" name="provider"><option value="simulated">simulated</option></select></div>
      <div class="field"><label for="rfr">From</label><input id="rfr" name="from" type="date" value="${from.toISOString().slice(0, 10)}"></div><div class="field"><label for="rto">To (exclusive)</label><input id="rto" name="to" type="date" value="${new Date(today.getTime() + 864e5).toISOString().slice(0, 10)}"></div></div>
      <div class="field"><label for="rc">Provider CSV <span class="muted">(optional, otherwise fetched from the provider)</span></label><textarea id="rc" name="csv" placeholder="reference,amount_cents,status,refunded_cents,fee_cents"></textarea></div><button class="btn btn-dark">Run reconciliation</button></form></section>` : ""}
    <section class="card mt"><h2>Ledger</h2><p class="${ledger.balanced ? "callout good" : "callout bad"} mb-0">${ledger.balanced ? "Every journal balances." : "Unbalanced journals found."} ${ledger.clearing.map((c) => `${c.account}: ledger ${moneyExact(c.ledgerCents)} vs expected ${moneyExact(c.expectedCents)}`).join(" · ")}</p></section>
    <h2 class="mt-lg">Runs</h2>${tbl(["When", "Period", "Source", "Matched", "Exceptions", "#Provider total", "#Internal total", ""], runs.map((r) => html`<tr><td class="small">${fmtDateTime(r.created_at)}<div class="tiny muted">${r.created_by_name || ""}</div></td><td class="small">${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}</td><td>${r.source}</td><td>${r.summary.matched || 0}</td><td>${r.summary.exceptions ? html`<span class="badge bad">${r.summary.exceptions}</span>` : "0"}</td><td class="num">${moneyExact(r.summary.providerTotalCents)}</td><td class="num">${moneyExact(r.summary.internalTotalCents)}</td><td><button class="btn btn-ghost btn-sm" data-run="${r.id}">Open</button></td></tr>`))}`);
  if ($("#rf")) onSubmit($("#rf"), async (v) => { await post("/api/admin/reconciliation", { provider: v.provider, from: new Date(v.from).toISOString(), to: new Date(v.to).toISOString(), csv: v.csv }); toast("Reconciliation complete.", "good"); reconciliation(); });
  $$("[data-run]").forEach((b) => b.addEventListener("click", async () => {
    const { items } = await get(`/api/admin/reconciliation/${b.dataset.run}`);
    const dlg = dialog("Reconciliation items", tbl(["Provider ref", "Outcome", "#Provider", "#Internal", "Status (prov / ours)", ""], items.map((i) => html`<tr><td class="mono small">${i.provider_reference}</td><td>${badge(i.outcome)}</td><td class="num">${i.provider_amount_cents != null ? moneyExact(i.provider_amount_cents) : "—"}</td><td class="num">${i.internal_amount_cents != null ? moneyExact(i.internal_amount_cents) : "—"}</td><td class="small">${i.provider_status || "—"} / ${i.internal_status || "—"}</td>
      <td>${i.resolved ? html`<span class="tiny muted">${i.resolution_note || "ok"}</span>` : isF() ? html`<button class="btn btn-ghost btn-sm" data-res="${i.id}">Resolve</button>` : ""}</td></tr>`)), { wide: true });
    $$("[data-res]", dlg).forEach((x) => x.addEventListener("click", async () => { const note = await reason("Resolve exception", "Explain what you checked and why this is resolved.", "Resolution note"); if (note && await act(() => post(`/api/admin/reconciliation/items/${x.dataset.res}/resolve`, { note }))) { x.replaceWith("resolved"); } }));
  }));
}

async function ledgerPage() {
  const [{ accounts }, { journals }] = await Promise.all([get("/api/admin/ledger/accounts"), get("/api/admin/ledger/journals")]);
  render(main, html`${head("Ledger", "Immutable double-entry ledger. Debits positive, credits negative; every journal sums to zero. Corrections are reversal journals.")}
    <h2>Accounts</h2>${tbl(["Account", "Kind", "#Balance", "#Entries"], accounts.map((a) => html`<tr><td class="mono small">${a.code}</td><td>${a.kind}</td><td class="num">${moneyExact(a.balance_cents)}</td><td class="num">${a.entries}</td></tr>`))}
    <h2 class="mt-lg">Recent journals</h2>${tbl(["When", "Kind", "Reference", "Lines"], journals.map((j) => html`<tr><td class="small">${fmtDateTime(j.created_at)}</td><td>${j.kind}${j.reverses_journal_id ? html`<div class="tiny muted">reversal</div>` : ""}</td><td class="mono small">${j.reference}</td><td class="small mono">${j.lines.map((l) => html`<div>${l.amount > 0 ? "DR" : "CR"} ${moneyExact(Math.abs(l.amount))} ${l.account}</div>`)}</td></tr>`))}`);
}

async function tags() {
  const draw = async (q = "") => {
    const { tags: list } = await get(`/api/admin/tags?q=${encodeURIComponent(q)}`);
    render($("#tl"), tbl(["Tag", "Type", "Security", "Event", "Owner", "Status", ""], list.map((t) => html`<tr><td class="mono">${t.display_code}</td><td>${t.tag_type.replace("_", " ")}</td><td>${t.security_level === "uid_only" ? html`<span class="badge warn">UID only</span>` : t.security_level.replace("_", " ")}</td><td class="small">${t.event_title || "—"}</td><td class="small">${t.owner_email || ""}</td><td>${badge(t.status)}${t.status_reason ? html`<div class="tiny muted">${t.status_reason}</div>` : ""}</td>
      <td><div class="row"><button class="btn btn-ghost btn-sm" data-h="${t.id}">History</button>${(isA() || isS()) && ["active", "assigned", "unassigned"].includes(t.status) ? html`<button class="btn btn-danger btn-sm" data-st="blocked" data-id="${t.id}">Block</button>` : ""}${(isA() || isS()) && t.status === "blocked" ? html`<button class="btn btn-ghost btn-sm" data-st="active" data-id="${t.id}">Unblock</button>` : ""}</div></td></tr>`)));
    $$("[data-h]").forEach((b) => b.addEventListener("click", async () => { const { history } = await get(`/api/admin/tags/${b.dataset.h}/history`); dialog("Tag history", tbl(["When", "Action", "By", "Details"], history.map((h) => html`<tr><td class="small">${fmtDateTime(h.occurred_at)}</td><td>${h.action}</td><td>${h.actor || ""}</td><td class="tiny mono">${JSON.stringify(h.details)}</td></tr>`)), { wide: true }); }));
    $$("[data-st]").forEach((b) => b.addEventListener("click", async () => { const why = await reason(b.dataset.st === "blocked" ? "Block tag" : "Unblock tag", "Logged on the tag's history."); if (why && await act(() => post(`/api/admin/tags/${b.dataset.id}/status`, { status: b.dataset.st, reason: why }))) draw(q); }));
  };
  const { events: evs } = await get("/api/admin/events?status=published");
  render(main, html`${head("Tags")}
    ${isA() ? html`<section class="card"><h2>Create a batch</h2><form class="stack" id="bf"><div class="grid-3">
      <div class="field"><label for="tt">Tag type</label><select id="tt" name="tagType"><option value="qr_tag">QR tag (printed)</option><option value="nfc_wristband">NFC wristband</option><option value="nfc_card">NFC card</option></select></div>
      <div class="field"><label for="tm">Mode</label><select id="tm" name="mode"><option value="generate">Generate tokens (QR print / NDEF encode)</option><option value="import">Import chip UIDs (identifier only)</option></select></div>
      <div class="field"><label for="te">Event</label><select id="te" name="eventId"><option value="">Not yet assigned</option>${evs.map((e) => html`<option value="${e.id}">${e.title}</option>`)}</select></div></div>
      <div class="grid-2"><div class="field"><label for="tq">Quantity</label><input id="tq" name="quantity" type="number" min="1" max="2000" value="50"></div><div class="field"><label for="tu">Chip UIDs (import mode, one per line)</label><textarea id="tu" name="uids" placeholder="04A1B2C3D4E5F6"></textarea></div></div>
      <p class="callout warn small mb-0"><strong>Security:</strong> UID-only tags are identifiers, not credentials: they are easy to clone and are refused for payments by default. Generated tokens on QR/NDEF can be copied too; pair them with spending PINs and limits. Cryptographic tags (e.g. NTAG 424 DNA SUN) are not yet supported.</p>
      <button class="btn btn-dark">Create batch & download CSV</button></form></section>` : ""}
    <h2 class="mt-lg">Search</h2><form class="row" id="ts"><input id="tqq" class="grow mono" placeholder="Tag code" aria-label="Tag code"><button class="btn btn-ghost">Search</button></form><div id="tl" class="mt">${spinner()}</div>`);
  if ($("#bf")) onSubmit($("#bf"), async (v) => {
    const body = { tagType: v.tagType, mode: v.mode, eventId: v.eventId || undefined, quantity: v.mode === "generate" ? Number(v.quantity) : undefined, uids: v.mode === "import" ? String(v.uids || "").split(/\s+/).filter(Boolean) : undefined };
    const r = await post("/api/admin/tag-batches", body);
    const csv = ["payload,display_code,activation_code,security_level", ...r.tags.map((t) => [t.payload, t.displayCode, t.activationCode, t.securityLevel].join(","))].join("\n");
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `ticketroom-tags-${r.batchId.slice(0, 8)}.csv` });
    a.click(); toast(`${r.tags.length} tags created. The CSV is the only copy of the tokens and activation codes. Store it somewhere safe.`, "good"); draw();
  });
  $("#ts").addEventListener("submit", (e) => { e.preventDefault(); draw($("#tqq").value); });
  draw();
}

async function terminals() {
  const { terminals: list } = await get("/api/admin/terminals");
  render(main, html`${head("Terminals")}${tbl(["Terminal", "Vendor", "Event", "Last seen", "Status", ""], list.map((t) => html`<tr><td>${t.label}</td><td>${t.vendor_name}</td><td class="small">${t.event_title}</td><td class="small">${t.last_seen_at ? fmtDateTime(t.last_seen_at) : "never"}</td><td>${badge(t.status)}</td>
    <td>${isA() && t.status !== "retired" ? html`<button class="btn btn-ghost btn-sm" data-t="${t.id}" data-s="${t.status === "active" ? "suspended" : "active"}">${t.status === "active" ? "Suspend" : "Activate"}</button>` : ""}</td></tr>`))}`);
  $$("[data-t]").forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/terminals/${b.dataset.t}/status`, { status: b.dataset.s }))) terminals(); }));
}

async function support() {
  const { cases } = await get("/api/admin/support");
  const open = cases.filter((c) => ["open", "in_progress"].includes(c.status));
  render(main, html`${head("Support & callbacks", `${open.length} open · ${open.filter((c) => c.overdue).length} overdue. Callback requests promise a response within 24–48 hours.`)}
    ${tbl(["Ref", "Customer", "Topic", "Request", "Due", "Status", ""], cases.map((c) => html`<tr><td class="mono">${c.reference}<div class="tiny muted">${c.source || "web"}</div></td>
      <td class="small">${c.full_name ? html`<strong>${c.full_name}</strong><br>` : ""}${c.phone ? html`<a href="tel:${c.phone}">${c.phone}</a><br>` : ""}<a href="mailto:${c.email}">${c.email}</a>${c.preferred_time ? html`<div class="tiny muted">best time: ${c.preferred_time}</div>` : ""}</td>
      <td>${c.category}</td><td><strong>${c.subject}</strong><div class="small muted">${c.body.slice(0, 160)}</div></td>
      <td class="small">${c.due_at ? html`${fmtDateTime(c.due_at)}${c.overdue ? html`<div><span class="badge bad">overdue</span></div>` : ""}` : "—"}</td><td>${badge(c.status)}${c.assignee ? html`<div class="tiny muted">${c.assignee}</div>` : ""}</td>
      <td>${isA() || isS() ? html`<button class="btn btn-ghost btn-sm" data-c="${c.id}">Update</button>` : ""}</td></tr>`))}`);
  $$("[data-c]").forEach((b) => b.addEventListener("click", () => {
    const c = cases.find((x) => String(x.id) === b.dataset.c);
    const dlg = dialog(c.subject, html`<p class="prose small">${c.body}</p><form class="stack"><div class="field"><label for="ss">Status</label><select id="ss" name="status">${["open", "in_progress", "resolved", "closed"].map((s) => html`<option ${raw(s === c.status ? "selected" : "")}>${s}</option>`)}</select></div><div class="field"><label for="sr">Resolution notes</label><textarea id="sr" name="resolution">${c.resolution || ""}</textarea></div><button class="btn btn-dark">Save</button></form>`);
    onSubmit($("form", dlg), async (v) => { await post(`/api/admin/support/${c.id}`, v); dlg.close(); support(); });
  }));
}

async function audit() {
  const { entries } = await get("/api/admin/audit");
  render(main, html`${head("Audit log", "Append-only and hash-chained. The database refuses edits and deletions; the chain check detects tampering done around it.", html`<button class="btn btn-dark" data-verify>Verify chain</button>`)}
    ${tbl(["When", "Actor", "Action", "Entity", "Details"], entries.map((e) => html`<tr><td class="small">${fmtDateTime(e.occurred_at)}</td><td class="small">${e.actor_name || e.actor_role}</td><td><code>${e.action}</code></td><td class="small mono">${e.entity_type || ""} ${e.entity_id ? e.entity_id.slice(0, 8) : ""}</td><td class="tiny mono">${JSON.stringify(e.details).slice(0, 160)}</td></tr>`))}`);
  $("[data-verify]").addEventListener("click", async () => { const r = await get("/api/admin/audit/verify"); toast(r.ok ? `Chain intact (${r.checked} entries).` : `Chain BROKEN at entry ${r.brokenAt}.`, r.ok ? "good" : "bad"); });
}

async function outbox() {
  const { messages, adapters } = await get("/api/admin/outbox");
  render(main, html`${head("Messages", `Email adapter: ${adapters.email} · SMS adapter: ${adapters.sms}`)}${tbl(["When", "Channel", "Kind", "To", "Subject", "Status"], messages.map((m) => html`<tr><td class="small">${fmtDateTime(m.created_at)}</td><td>${m.channel}</td><td>${m.kind}</td><td class="small">${m.to_address}</td><td class="small">${m.subject || ""}</td><td>${badge(m.status)}${m.last_error ? html`<div class="tiny muted">${m.last_error}</div>` : ""}</td></tr>`))}`);
}

// ---------------- site settings: maintenance, banner, hours, support, legal, assistant ----------------
const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
async function siteSettings() {
  const { settings: s, hoursStatus: hs, aiConfigured, assistantModel } = await get("/api/admin/settings");
  const ro = raw(isA() ? "" : "disabled");
  const save = async (key, value, msg) => { if (await act(() => put(`/api/admin/settings/${key}`, value), msg)) siteSettings(); };
  render(main, html`${head("Site settings", "Changes apply to the live site within a few seconds. Every change is written to the audit log.")}
    ${!isA() ? html`<p class="callout">View only. Changing site settings needs the admin role.</p>` : ""}
    <div class="grid-2">
    <section class="card stack ${s.maintenance.enabled ? "flat" : ""}" aria-labelledby="mt-h"><h2 id="mt-h">Maintenance mode ${s.maintenance.enabled ? html`<span class="badge bad">ON</span>` : html`<span class="badge good">off</span>`}</h2>
      <p class="small muted mb-0">When on, visitors see a maintenance page. TicketRoom staff can still sign in and use the site. Webhooks from payment providers keep working.</p>
      <form class="stack" id="f-mt"><div class="field"><label for="mt-msg">Message shown to visitors</label><textarea id="mt-msg" name="message" maxlength="500" ${ro}>${s.maintenance.message}</textarea></div>
        <div class="row">${s.maintenance.enabled ? html`<button class="btn btn-good" name="enabled" value="0" ${ro}>Turn maintenance OFF</button>` : html`<button class="btn btn-danger" name="enabled" value="1" ${ro}>Turn maintenance ON</button>`}<button type="button" class="btn btn-ghost" data-save-mt ${ro}>Save message only</button></div></form></section>

    <section class="card stack" aria-labelledby="bn-h"><h2 id="bn-h">Announcement banner ${s.banner.enabled ? html`<span class="badge good">showing</span>` : html`<span class="badge">hidden</span>`}</h2>
      <p class="small muted mb-0">Shown at the top of every public page. Visitors can hide it for their visit; turn it off here to remove it for everyone.</p>
      <form class="stack" id="f-bn"><label class="check"><input type="checkbox" name="enabled" ${raw(s.banner.enabled ? "checked" : "")} ${ro}><span>Show the banner</span></label>
        <div class="field"><label for="bn-t">Text</label><input id="bn-t" name="text" maxlength="200" required value="${s.banner.text}" ${ro}></div>
        <div class="grid-2"><div class="field"><label for="bn-lt">Link text <span class="muted">(optional)</span></label><input id="bn-lt" name="linkText" maxlength="40" value="${s.banner.linkText || ""}" ${ro}></div>
        <div class="field"><label for="bn-lu">Link</label><input id="bn-lu" name="linkUrl" maxlength="200" value="${s.banner.linkUrl || ""}" placeholder="/sell" ${ro}></div></div>
        <button class="btn btn-dark" ${ro}>Save banner</button></form></section>
    </div>

    <section class="card stack mt" aria-labelledby="hr-h"><h2 id="hr-h">Business hours & public holidays</h2>
      <p class="callout ${hs.openNow ? "good" : "warn"} mb-0">Right now: <strong>${hs.openNow ? "open" : `closed${hs.holiday ? ` (${hs.holiday})` : ""}`}</strong>${hs.nextOpen && !hs.openNow ? ` · next open ${hs.nextOpen.date} at ${hs.nextOpen.time}` : ""}. The assistant, help page and callback confirmations use these hours.</p>
      <form class="stack" id="f-hr">
        <div class="table-wrap"><table><thead><tr><th>Day</th><th>Open</th><th>Opens</th><th>Closes</th></tr></thead><tbody>
          ${DAYS.map(([k, l]) => html`<tr><td>${l}</td><td><input type="checkbox" name="${k}-on" aria-label="${l} open" ${raw(s.hours.week[k] ? "checked" : "")} ${ro}></td>
            <td><input type="time" name="${k}-open" aria-label="${l} opens" value="${s.hours.week[k]?.open || "09:00"}" ${ro}></td><td><input type="time" name="${k}-close" aria-label="${l} closes" value="${s.hours.week[k]?.close || "17:00"}" ${ro}></td></tr>`)}</tbody></table></div>
        <div class="field"><label for="hr-note">Hours note (shown to customers)</label><input id="hr-note" name="note" maxlength="200" value="${s.hours.note}" ${ro}></div>
        <div class="field"><label for="hr-hol">Closed days, one per line as <code>YYYY-MM-DD Name</code></label><textarea id="hr-hol" name="holidays" rows="10" class="mono" ${ro}>${s.hours.holidays.map((h) => `${h.date} ${h.name}`).join("\n")}</textarea>
          <span class="hint">South African public holidays for 2026–2027 are pre-loaded. Add company closures (e.g. 2026-12-24 Christmas Eve) the same way.</span></div>
        <button class="btn btn-dark" ${ro}>Save hours</button></form></section>

    <div class="grid-2 mt">
    <section class="card stack" aria-labelledby="sp-h"><h2 id="sp-h">Support contact</h2><form class="stack" id="f-sp">
      <div class="field"><label for="sp-e">Support email</label><input id="sp-e" name="email" type="email" required value="${s.support.email}" ${ro}></div>
      <div class="field"><label for="sp-p">Phone <span class="muted">(optional, shown on contact page)</span></label><input id="sp-p" name="phone" maxlength="30" value="${s.support.phone || ""}" ${ro}></div>
      <div class="field"><label for="sp-r">Response time promise</label><input id="sp-r" name="responseTime" maxlength="40" required value="${s.support.responseTime}" ${ro}></div>
      <button class="btn btn-dark" ${ro}>Save contact details</button></form></section>

    <section class="card stack" aria-labelledby="ai-h"><h2 id="ai-h">Assistant (chatbot)</h2>
      <p class="small muted mb-0">Answers come from the <a href="#/assistant">knowledge base</a>. ${aiConfigured ? html`Smart answers use Claude (<code>${assistantModel}</code>) and are grounded in the knowledge base.` : html`<strong>Smart answers are off</strong>: set <code>ANTHROPIC_API_KEY</code> in the app's .env to enable them. The knowledge base works without it.`}</p>
      <form class="stack" id="f-ai"><label class="check"><input type="checkbox" name="enabled" ${raw(s.chatbot.enabled ? "checked" : "")} ${ro}><span>Show the assistant on the website</span></label>
        <label class="check"><input type="checkbox" name="aiEnabled" ${raw(s.chatbot.aiEnabled ? "checked" : "")} ${ro}><span>Use smart (AI) answers when configured</span></label>
        <div class="field"><label for="ai-g">Greeting</label><textarea id="ai-g" name="greeting" maxlength="300" ${ro}>${s.chatbot.greeting}</textarea></div>
        <button class="btn btn-dark" ${ro}>Save assistant</button></form></section>
    </div>

    <section class="card stack mt" aria-labelledby="lg-h"><h2 id="lg-h">Legal details</h2>
      <p class="small muted mb-0">Inserted into the Terms, Privacy Policy and PAIA pages. Complete these before launch (CIPC registration, VAT number if registered, address and Information Officer registered with the Information Regulator).</p>
      <form class="stack" id="f-lg"><div class="grid-2">
        <div class="field"><label for="lg-n">Legal entity name</label><input id="lg-n" name="entityName" required maxlength="160" value="${s.legal.entityName}" ${ro}></div>
        <div class="field"><label for="lg-r">Company registration number</label><input id="lg-r" name="registrationNumber" maxlength="40" value="${s.legal.registrationNumber || ""}" placeholder="2026/123456/07" ${ro}></div>
        <div class="field"><label for="lg-v">VAT number</label><input id="lg-v" name="vatNumber" maxlength="40" value="${s.legal.vatNumber || ""}" ${ro}></div>
        <div class="field"><label for="lg-i">Information Officer</label><input id="lg-i" name="informationOfficer" maxlength="120" value="${s.legal.informationOfficer || ""}" ${ro}></div>
        <div class="field"><label for="lg-a">Physical address</label><input id="lg-a" name="physicalAddress" maxlength="300" value="${s.legal.physicalAddress || ""}" ${ro}></div>
        <div class="field"><label for="lg-p">Postal address</label><input id="lg-p" name="postalAddress" maxlength="300" value="${s.legal.postalAddress || ""}" ${ro}></div></div>
        <input type="hidden" name="website" value="${s.legal.website || "ticketroom.co.za"}">
        <div class="row"><button class="btn btn-dark" ${ro}>Save legal details</button><a class="btn btn-ghost" href="/legal/terms" target="_blank">Preview documents</a></div></form></section>`);
  if (!isA()) return;
  const fv = (f) => Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, String(v)]));
  $("#f-mt").addEventListener("submit", async (e) => {
    e.preventDefault();
    const on = e.submitter?.value === "1";
    if (on && !(await confirmDialog("Turn maintenance mode on?", "Visitors will see the maintenance page until you turn it off. Staff can still sign in.", { confirm: "Turn on", danger: true }))) return;
    save("maintenance", { enabled: on, message: $("#mt-msg").value }, on ? "Maintenance mode is ON." : "Maintenance mode is off. The site is live.");
  });
  $("[data-save-mt]").addEventListener("click", () => save("maintenance", { enabled: s.maintenance.enabled, message: $("#mt-msg").value }, "Message saved."));
  $("#f-bn").addEventListener("submit", (e) => { e.preventDefault(); const v = fv(e.target); save("banner", { enabled: e.target.enabled.checked, text: v.text, linkText: v.linkText || undefined, linkUrl: v.linkUrl || undefined }, "Banner saved."); });
  $("#f-hr").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target, week = {};
    for (const [k] of DAYS) week[k] = f[`${k}-on`].checked ? { open: f[`${k}-open`].value, close: f[`${k}-close`].value } : null;
    const holidays = f.holidays.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const m = l.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/); return m ? { date: m[1], name: m[2].slice(0, 80) } : { date: l, name: "" }; });
    const badLine = holidays.find((h) => !h.name);
    if (badLine) return toast(`Holiday line "${badLine.date}" needs the format YYYY-MM-DD Name.`, "bad");
    save("hours", { week, holidays: holidays.sort((a, b) => a.date.localeCompare(b.date)), note: f.note.value }, "Hours saved.");
  });
  $("#f-sp").addEventListener("submit", (e) => { e.preventDefault(); const v = fv(e.target); save("support", { email: v.email, phone: v.phone || undefined, responseTime: v.responseTime }, "Contact details saved."); });
  $("#f-ai").addEventListener("submit", (e) => { e.preventDefault(); save("chatbot", { enabled: e.target.enabled.checked, aiEnabled: e.target.aiEnabled.checked, greeting: e.target.greeting.value }, "Assistant saved."); });
  $("#f-lg").addEventListener("submit", (e) => { e.preventDefault(); const v = fv(e.target); for (const k of Object.keys(v)) if (!v[k]) delete v[k]; save("legal", v, "Legal details saved."); });
}

// ---------------- advertising posters ----------------
async function posters() {
  const { posters: list } = await get("/api/admin/posters");
  const live = (p) => p.active && (!p.starts_at || new Date(p.starts_at) <= new Date()) && (!p.ends_at || new Date(p.ends_at) > new Date());
  render(main, html`${head("Advertising posters", "Posters appear in the Featured section on the home page. Use them for partner adverts, sponsors or your own promotions.", isA() ? html`<button class="btn btn-primary" data-new>New poster</button>` : "")}
    ${list.length ? html`<div class="poster-rail">${list.map((p) => html`<article class="card flat stack">
      <div class="ad-poster">${p.image_upload_id ? html`<img src="/media/${p.image_upload_id}" alt="">` : ""}<div class="meta"><h3>${p.title}</h3>${p.subtitle ? html`<span>${p.subtitle}</span>` : ""}</div></div>
      <div class="row between"><span>${live(p) ? html`<span class="badge good">live</span>` : p.active ? html`<span class="badge warn">scheduled</span>` : html`<span class="badge">paused</span>`}</span><span class="small muted">${p.clicks} clicks</span></div>
      <p class="small muted mb-0">${p.link_url || "No link"}${p.starts_at || p.ends_at ? html`<br>${p.starts_at ? fmtDate(p.starts_at) : "now"} – ${p.ends_at ? fmtDate(p.ends_at) : "no end"}` : ""}</p>
      ${isA() ? html`<div class="row"><button class="btn btn-ghost btn-sm" data-edit="${p.id}">Edit</button><button class="btn btn-ghost btn-sm" data-toggle="${p.id}">${p.active ? "Pause" : "Activate"}</button><button class="btn btn-ghost btn-sm" data-del="${p.id}">Delete</button></div>` : ""}</article>`)}</div>`
      : empty("No posters yet. Create one to advertise on the home page.")}`);
  const editor = (p = {}) => {
    const d = dialog(p.id ? "Edit poster" : "New poster", html`<form class="stack">
      <div class="field"><label for="pt">Title</label><input id="pt" name="title" required maxlength="120" value="${p.title || ""}"></div>
      <div class="field"><label for="ps">Subtitle <span class="muted">(optional)</span></label><input id="ps" name="subtitle" maxlength="200" value="${p.subtitle || ""}"></div>
      <div class="field"><label for="pi">Image (16:9, PNG/JPEG/WebP, up to 2 MB)</label><input id="pi" type="file" accept="image/png,image/jpeg,image/webp"><input type="hidden" name="imageUploadId" value="${p.image_upload_id || ""}"></div>
      <div class="field"><label for="pl">Link <span class="muted">(/events/… or https://…)</span></label><input id="pl" name="linkUrl" maxlength="300" value="${p.link_url || ""}"></div>
      <div class="grid-2"><div class="field"><label for="pa">Starts <span class="muted">(optional)</span></label><input id="pa" name="startsAt" type="date" value="${p.starts_at ? p.starts_at.slice(0, 10) : ""}"></div>
        <div class="field"><label for="pe">Ends <span class="muted">(optional)</span></label><input id="pe" name="endsAt" type="date" value="${p.ends_at ? p.ends_at.slice(0, 10) : ""}"></div></div>
      <div class="field"><label for="po">Order (lower shows first)</label><input id="po" name="sortOrder" type="number" min="0" max="1000" value="${p.sort_order ?? 100}"></div>
      <button class="btn btn-primary">${p.id ? "Save" : "Create poster"}</button></form>`);
    const f = $("form", d);
    $("#pi", d).addEventListener("change", async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try { const r = await api("POST", "/api/admin/uploads", undefined, { raw: file, headers: { "content-type": file.type } }); f.imageUploadId.value = r.uploadId; toast("Image uploaded.", "good"); }
      catch (err) { toast(err.message, "bad"); e.target.value = ""; }
    });
    onSubmit(f, async (v) => {
      const body = { title: v.title, subtitle: v.subtitle, imageUploadId: v.imageUploadId || undefined, linkUrl: v.linkUrl || undefined, sortOrder: Number(v.sortOrder || 100),
        startsAt: v.startsAt ? new Date(`${v.startsAt}T00:00:00+02:00`).toISOString() : undefined, endsAt: v.endsAt ? new Date(`${v.endsAt}T23:59:59+02:00`).toISOString() : undefined };
      if (p.id) await patch(`/api/admin/posters/${p.id}`, body); else await post("/api/admin/posters", body);
      d.close(); toast("Poster saved.", "good"); posters();
    });
  };
  $("[data-new]")?.addEventListener("click", () => editor());
  $$("[data-edit]").forEach((b) => b.addEventListener("click", () => editor(list.find((p) => p.id === b.dataset.edit))));
  $$("[data-toggle]").forEach((b) => b.addEventListener("click", async () => { const p = list.find((x) => x.id === b.dataset.toggle); if (await act(() => patch(`/api/admin/posters/${p.id}`, { active: !p.active }))) posters(); }));
  $$("[data-del]").forEach((b) => b.addEventListener("click", async () => { if (await confirmDialog("Delete poster?", "This can't be undone.", { confirm: "Delete", danger: true }) && await act(() => del(`/api/admin/posters/${b.dataset.del}`))) posters(); }));
}

// ---------------- assistant: knowledge base + conversations ----------------
async function assistantPage() {
  const tab = sessionStorage.getItem("adm_as") || "kb";
  const canEdit = isA() || isS();
  const [{ articles }, { chats, stats }] = await Promise.all([get("/api/admin/kb"), get(`/api/admin/chats${tab === "gaps" ? "?filter=unanswered" : ""}`)]);
  render(main, html`${head("Assistant", "The chatbot answers from this knowledge base (and, when enabled, uses it to ground smart answers). Fix gaps by adding articles.", canEdit ? html`<button class="btn btn-primary" data-new>New article</button>` : "")}
    <div class="kpis"><div class="kpi"><div class="k">Questions (30 days)</div><div class="v">${stats.total}</div><div class="s">${stats.ai} smart answers</div></div>
      <div class="kpi"><div class="k">Not answered</div><div class="v">${stats.unanswered}</div><div class="s">add articles for these</div></div>
      <div class="kpi"><div class="k">Helpful</div><div class="v">${stats.helpful}</div><div class="s">${stats.unhelpful} not helpful</div></div></div>
    <div class="chips mt">${[["kb", "Knowledge base"], ["log", "All conversations"], ["gaps", "Gaps & unhelpful"]].map(([k, l]) => html`<button class="chip" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`)}</div>
    <div class="mt">${tab === "kb" ? tbl(["Question", "Answer", "Link", "Status", ""], articles.map((a) => html`<tr><td><strong>${a.question}</strong><div class="tiny muted">${(a.keywords || []).join(", ")}</div></td><td class="small">${a.answer.slice(0, 220)}${a.answer.length > 220 ? "…" : ""}</td><td class="small mono">${a.link_url || ""}</td><td>${a.active ? badge("active") : html`<span class="badge">off</span>`}</td>
        <td>${canEdit ? html`<button class="btn btn-ghost btn-sm" data-edit="${a.id}">Edit</button>` : ""}</td></tr>`))
      : tbl(["When", "Question", "Answer", "Source", "Feedback"], chats.map((c) => html`<tr><td class="small">${fmtDateTime(c.created_at)}</td><td><strong>${c.question}</strong>${c.matched ? html`<div class="tiny muted">matched: ${c.matched}</div>` : ""}</td><td class="small">${c.answer.slice(0, 240)}</td><td>${c.source}</td><td>${c.helpful === true ? "Helpful" : c.helpful === false ? "Not helpful" : ""}${canEdit && tab === "gaps" ? html` <button class="btn btn-ghost btn-sm" data-from="${c.id}">Answer it</button>` : ""}</td></tr>`))}</div>`);
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => { sessionStorage.setItem("adm_as", b.dataset.tab); assistantPage(); }));
  const editor = (a = {}) => {
    const d = dialog(a.id ? "Edit article" : "New article", html`<form class="stack">
      <div class="field"><label for="kq">Question</label><input id="kq" name="question" required minlength="5" maxlength="200" value="${a.question || ""}"></div>
      <div class="field"><label for="ka">Answer</label><textarea id="ka" name="answer" required maxlength="2000" rows="6">${a.answer || ""}</textarea></div>
      <div class="field"><label for="kk">Keywords <span class="muted">(comma separated, in the words customers use)</span></label><input id="kk" name="keywords" value="${(a.keywords || []).join(", ")}"></div>
      <div class="field"><label for="kl">Link <span class="muted">(optional site path, e.g. /contact)</span></label><input id="kl" name="linkUrl" maxlength="200" value="${a.link_url || ""}"></div>
      ${a.id ? html`<label class="check"><input type="checkbox" name="active" ${raw(a.active ? "checked" : "")}><span>Active</span></label>` : ""}
      <button class="btn btn-primary">Save</button></form>`, { wide: true });
    onSubmit($("form", d), async (v) => {
      const body = { question: v.question, answer: v.answer, keywords: String(v.keywords || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 30), linkUrl: v.linkUrl || undefined };
      if (a.id) await patch(`/api/admin/kb/${a.id}`, { ...body, active: !!v.active }); else await post("/api/admin/kb", body);
      d.close(); toast("Article saved. The assistant uses it straight away.", "good"); assistantPage();
    });
  };
  $("[data-new]")?.addEventListener("click", () => editor());
  $$("[data-edit]").forEach((b) => b.addEventListener("click", () => editor(articles.find((a) => a.id === Number(b.dataset.edit) || a.id === b.dataset.edit))));
  $$("[data-from]").forEach((b) => b.addEventListener("click", () => editor({ question: chats.find((c) => String(c.id) === b.dataset.from)?.question })));
}

// ---------------- email templates ----------------
async function emailsPage() {
  const { emails, settings: st, delivery } = await get("/api/admin/emails");
  const ro = raw(isA() ? "" : "disabled");
  const groups = ["Attendee", "Everyone", "Organiser", "Staff"];
  const auto = (e) => e.setting ? (st[e.setting] ? html`<span class="badge good">automatic · on</span>` : html`<span class="badge">automatic · off</span>`) : html`<span class="badge info">sent when it happens</span>`;
  render(main, html`${head("Email templates", "Every email TicketRoom sends. Each is sent as a branded HTML email with a plain-text version.")}
    ${delivery === "log" ? html`<p class="callout bad"><strong>Emails are not being delivered.</strong> Add the hello@ticketroom.co.za mailbox settings (SMTP_HOST, SMTP_USER, SMTP_PASS) to the app's .env file and restart.</p>` : ""}
    <section class="card stack"><h2>Automatic emails</h2>
      <form class="stack" id="f-em">
        <label class="check"><input type="checkbox" name="reminderDayBefore" ${raw(st.reminderDayBefore ? "checked" : "")} ${ro}><span><strong>Day-before reminder</strong> to every ticket holder, about 24 hours before the event</span></label>
        <label class="check"><input type="checkbox" name="reminderSoon" ${raw(st.reminderSoon ? "checked" : "")} ${ro}><span><strong>Starting-soon reminder</strong> within 3 hours of the start, with tips for the gate</span></label>
        <label class="check"><input type="checkbox" name="abandonedCheckout" ${raw(st.abandonedCheckout ? "checked" : "")} ${ro}><span><strong>Abandoned checkout</strong>: once per person per event, only while tickets are still on sale, never to people who unsubscribed</span></label>
        <div class="field"><label for="em-d">Send the abandoned-checkout email after</label><select id="em-d" name="abandonedDelayHours" ${ro}>${[1, 2, 3, 6, 12, 24].map((h) => html`<option value="${h}" ${raw(h === st.abandonedDelayHours ? "selected" : "")}>${h} hour${h === 1 ? "" : "s"}</option>`)}</select></div>
        <p class="tiny muted mb-0">Each email is sent at most once. Reminders need the background jobs cron (see the setup guide) or the app to be running.</p>
        ${isA() ? html`<div><button class="btn btn-dark">Save</button></div>` : ""}</form></section>
    ${groups.map((g) => html`<h2 class="mt-lg">${g === "Everyone" ? "Account & support" : `${g} emails`}</h2><div class="grid-2">${emails.filter((e) => e.audience === g).map((e) => html`<article class="card stack">
      <div class="row between"><h3 class="mb-0">${e.name}</h3>${auto(e)}</div>
      <p class="small muted mb-0">${e.trigger}</p>
      <p class="small mb-0"><strong>Subject:</strong> ${e.subject}</p>
      <div class="row"><button class="btn btn-ghost btn-sm" data-prev="${e.key}">Preview</button>${isA() ? html`<button class="btn btn-ghost btn-sm" data-test="${e.key}">Send me a test</button>` : ""}</div></article>`)}</div>`)}`);
  $("#f-em").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    if (await act(() => put("/api/admin/settings/emails", { reminderDayBefore: f.reminderDayBefore.checked, reminderSoon: f.reminderSoon.checked, abandonedCheckout: f.abandonedCheckout.checked, abandonedDelayHours: Number(f.abandonedDelayHours.value) }), "Email settings saved.")) emailsPage();
  });
  $$("[data-prev]").forEach((b) => b.addEventListener("click", () => {
    const e = emails.find((x) => x.key === b.dataset.prev);
    const d = dialog(e.name, html`<p class="small mb-0"><strong>Subject:</strong> ${e.subject}</p>
      <div class="chips mt"><button class="chip" data-v="html" aria-pressed="true">Email</button><button class="chip" data-v="text" aria-pressed="false">Plain text</button></div>
      <iframe class="email-frame mt" title="Email preview" src="/api/admin/emails/${e.key}/preview" sandbox></iframe><pre class="email-text mt" hidden>${e.body}</pre>
      <p class="tiny muted mb-0">Preview uses sample data. Real emails use the attendee's and event's details.</p>`, { wide: true });
    $$("[data-v]", d).forEach((c) => c.addEventListener("click", () => {
      $$("[data-v]", d).forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
      $(".email-frame", d).hidden = c.dataset.v !== "html"; $(".email-text", d).hidden = c.dataset.v !== "text";
    }));
  }));
  $$("[data-test]").forEach((b) => b.addEventListener("click", async () => { try { const r = await post(`/api/admin/emails/${b.dataset.test}/test`); toast(`Test sent to ${r.to}.`, "good"); } catch (err) { toast(err.message, "bad"); } }));
}

// ---------------- integrations ----------------
async function integrations() {
  const d = await get("/api/admin/integrations");
  render(main, html`${head("Integrations", "TicketRoom's own provider accounts. Passwords and keys stay on the server and are never shown here. You only see whether each one is set.")}
    <p class="callout small">Fees: buyers pay ${moneyExact(d.defaults.bookingFeeCents)} per paid ticket${d.defaults.bookingFeeBps ? ` + ${d.defaults.bookingFeeBps / 100}%` : ""}; organisers pay ${d.defaults.organiserCommissionBps / 100}% commission (override per organiser under Organisers). Free events pay nothing.</p>
    <div class="stack">${d.integrations.map((i) => html`<section class="card stack"><div class="row between"><h2 class="mb-0">${i.label}</h2><span>${badge(i.provider === "none" || i.provider === "disabled" ? "draft" : "active")} <span class="badge ${i.environment === "live" ? "good" : "warn"}">${i.environment || "—"}</span></span></div>
      <dl class="dl"><dt>Provider</dt><dd>${i.provider}</dd><dt>Endpoint</dt><dd class="mono small">${i.endpoint || "—"}</dd>${i.webhookUrl ? html`<dt>Webhook URL</dt><dd class="mono small">${i.webhookUrl}</dd>` : ""}
        ${Object.entries(i.credentials || {}).map(([k, v]) => html`<dt>${k}</dt><dd>${v === "set" ? html`<span class="badge good">set</span>` : html`<span class="badge bad">missing</span>`}</dd>`)}
        <dt>Last 24h</dt><dd>${i.calls || 0} calls, ${i.failures || 0} failures${i.avg_ms ? `, avg ${i.avg_ms} ms` : ""}${i.problems ? html` · <span class="badge bad">${i.problems} webhook problems</span>` : ""}</dd></dl>
      ${isA() ? html`<div><button class="btn btn-ghost btn-sm" data-health="${i.key}">Run health check</button></div>` : ""}</section>`)}</div>`);
  $$("[data-health]").forEach((b) => b.addEventListener("click", async () => {
    try { const r = await post(`/api/admin/integrations/${b.dataset.health}/health`); toast(r.ok ? `Healthy${r.detail ? `. ${r.detail}` : ""}` : `Problem: ${r.error || r.detail || "check failed"}`, r.ok ? "good" : "bad"); }
    catch (err) { toast(err.message, "bad"); }
  }));
}

(async () => {
  // Nothing on this page says "admin" until a staff account has signed in.
  await header($("#header"));
  const u = await requireUser("Sign in to continue.");
  if (!u) return render(main, empty("Sign in to continue."));
  R = roles(await me(true));
  // Not staff: this address shows nothing about the admin portal.
  if (!R.size) {
    document.title = "Page not found | TicketRoom";
    render($("#sidenav"), "");
    return render(main, html`<div class="card pad-lg stack"><h1>Page not found</h1><p class="mb-0">That page doesn't exist.</p><a class="btn btn-primary" href="/">Browse events</a></div>`);
  }
  await header($("#header"), { portal: "admin" });
  document.title = "Admin portal | TicketRoom";
  nav();
  router([["/", overview], ["/organisers", organisers], ["/events", events], ["/users", users], ["/lookup", lookup], ["/tags", gate("tags", tags)], ["/terminals", gate("pos", terminals)], ["/support", support],
    ["/refunds", gate("finance", refunds)], ["/payouts", gate("finance", payouts)], ["/payments", gate("finance", payments)], ["/reconciliation", gate("finance", reconciliation)], ["/ledger", gate("finance", ledgerPage)], ["/audit", audit], ["/outbox", outbox], ["/site", siteSettings], ["/posters", posters], ["/assistant", assistantPage], ["/emails", emailsPage], ["/integrations", integrations], ["/password", myPassword], ["/subscribers", subscribers], ["/qr", qrStudio], ["/staff", staffPage]], () => { location.hash = "#/"; });
})();
