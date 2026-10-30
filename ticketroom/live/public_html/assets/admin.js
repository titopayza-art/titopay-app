// TicketRoom back office. The server enforces every permission; the UI only
// hides what a role cannot do.
import { features, html, raw, render, $, $$, get, post, put, patch, del, api, money, moneyExact, plural, parseRand, fmtDate, fmtDateTime, header, requireUser, toast, onSubmit, badge, empty, spinner, dialog, confirmDialog, router, roles, me, gate, matchPasswords, emailLinkPage, qrPanel, ApiError } from "/assets/core.js";
import { deskPicker } from "/assets/cashdesk.js";

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
        <div class="field"><label for="se">Work email</label><input id="se" name="email" type="email" required><span class="hint">A new staff account is made for this email, and they get a link to set their password. Customer and organiser emails can't be used.</span></div></div>
        ${roleBoxes("r_")}<button class="btn btn-primary">Add to the team</button></form></section>` : ""}
    <section class="mt"><h2>The team</h2>${tbl(["Name", "Email", "Roles", ""], staff.map((s) => html`<tr><td>${s.full_name}${s.owner ? html` <span class="badge info">Owner</span>` : ""}${s.id === meId ? html` <span class="tiny muted">(you)</span>` : ""}</td><td class="small">${s.email}</td>
      <td>${s.status !== "active" ? html`<span class="badge plain">Off the team</span>` : s.roles.map((r) => html`<span class="badge ${r === "admin" ? "bad" : r === "finance" ? "info" : "good"}">${(ROLE_INFO.find(([k]) => k === r) || [, r])[1]}</span> `)}</td>
      <td class="nowrap">${isA() && s.id !== meId && !s.owner ? html`<button class="btn btn-ghost btn-sm" data-edit="${s.id}">Change roles</button>${s.status === "active" ? html` <button class="btn btn-ghost btn-sm" data-reset="${s.id}">Send password link</button>` : ""}` : ""}</td></tr>`), "No staff yet.")}
      <p class="small muted">Staff can't reset their own password from the sign-in box. If someone is locked out, send them a password link here; it works for 24 hours. The owner's account can only be changed by the owner.</p></section>`);
  const f = $("#sf");
  if (f) onSubmit(f, async (v) => {
    const roles = ROLE_INFO.map(([k]) => k).filter((k) => v[`r_${k}`]);
    if (!roles.length) throw new ApiError(422, { error: { message: "Tick at least one role." } });
    const r = await post("/api/admin/staff", { fullName: v.fullName, email: v.email, roles });
    toast(r.invited ? `Added. ${v.email} will get an email to set a password.` : `Added. ${v.email} can sign in with their usual password.`, "good");
    staffPage();
  });
  $$("[data-reset]").forEach((b) => b.addEventListener("click", async () => {
    const s = staff.find((x) => x.id === b.dataset.reset);
    if (!(await confirmDialog(`Send ${s.full_name} a password link?`, `${s.email} gets a link to choose a new password, valid for 24 hours. Their current password keeps working until they use it.`, { confirm: "Send link" }))) return;
    try { const r = await post(`/api/admin/staff/${s.id}/reset`); toast(r.message, "good"); } catch (err) { toast(err.message, "bad"); }
  }));
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

async function retailPartners() {
  const { partners } = await get("/api/admin/retail-partners");
  render(main, html`${head("Retail partners", "Review shop applications, track attributed sales and reconcile partner earnings.")}
    <section class="card stack"><p class="small muted mb-0">Partners are approved before selling. Shares are snapshots taken on new orders and come from commission/service-fee revenue already charged; refunds reverse the corresponding partner share. Recorded payouts are checked against the retail-partner payable ledger.</p>
      ${tbl(["Application", "Contact", "Channels", "Status", "Orders", "Due", ""], partners.map((p) => html`<tr><td><strong>${p.business_name}</strong><div class="tiny muted">${p.ref} · ${p.registration_number || "No registration number supplied"}</div><div class="tiny">${p.store_address}</div></td><td>${p.owner_name}<div class="tiny muted">${p.owner_email} · ${p.contact_phone}</div></td><td>${p.sales_channels.join(" · ")}</td><td>${badge(p.status)}</td><td class="num">${Number(p.paid_orders)}</td><td class="num">${moneyExact(p.balance_cents)}</td><td class="nowrap"><button class="btn btn-ghost btn-sm" data-sales="${p.id}">Sales</button>${isA() && p.status === "pending" ? html` <button class="btn btn-good btn-sm" data-status="approved" data-id="${p.id}">Approve</button> <button class="btn btn-ghost btn-sm" data-status="rejected" data-id="${p.id}">Reject</button>` : isA() && p.status === "approved" ? html` <button class="btn btn-danger btn-sm" data-status="suspended" data-id="${p.id}">Suspend</button>` : ""}${isF() && p.status === "approved" && p.balance_cents > 0 ? html` <button class="btn btn-primary btn-sm" data-payout="${p.id}" data-balance="${p.balance_cents}">Record payout</button>` : ""}</td></tr>`), "No retail partner applications yet.")}</section>`);
  $$('[data-status]', main).forEach((b) => b.addEventListener("click", async () => {
    const note = b.dataset.status === "approved" ? "" : prompt("Optional review note (shown to the applicant):") || "";
    try { await post(`/api/admin/retail-partners/${b.dataset.id}/status`, { status: b.dataset.status, note: note || undefined }); toast(`Retail partner ${b.dataset.status}.`, "good"); retailPartners(); } catch (err) { toast(err.message, "bad"); }
  }));
  $$('[data-sales]', main).forEach((b) => b.addEventListener("click", async () => {
    try {
      const d = await get(`/api/admin/retail-partners/${b.dataset.sales}/sales`);
      dialog("Retail partner sales", html`<div class="stack"><p>Recorded unpaid partner balance: <strong>${moneyExact(d.balanceCents)}</strong>. The per-order share is the amount snapshotted at sale, before any later refund reversals.</p>${tbl(["Date", "Event", "Order", "Buyer", "Tender", "Total", "Share at sale"], d.orders.map((o) => html`<tr><td>${fmtDateTime(o.created_at)}</td><td>${o.title}</td><td>${o.reference} · ${o.status}</td><td>${o.buyer_name}</td><td>${o.tender_method || "online"}${o.tender_reference ? html`<div class="tiny muted">${o.tender_reference}</div>` : ""}</td><td class="num">${moneyExact(o.total_cents)}</td><td class="num">${moneyExact(Number(o.retail_commission_share_cents) + Number(o.retail_service_share_cents))}</td></tr>`), "No attributed orders yet.")}</div>`);
    } catch (err) { toast(err.message, "bad"); }
  }));
  $$('[data-payout]', main).forEach((b) => b.addEventListener("click", async () => {
    const amount = prompt(`Maximum available: ${moneyExact(b.dataset.balance)}. Enter payout amount in Rand:`);
    if (amount === null) return;
    const ref = prompt("Enter the EFT / bank transaction reference:"); if (!ref) return;
    const cents = parseRand(amount);
    if (cents === null || cents < 1) return toast("Enter a valid payout amount.", "bad");
    try { await post(`/api/admin/retail-partners/${b.dataset.payout}/payout`, { amountCents: cents, bankReference: ref.trim() }); toast("Partner payout recorded against the ledger.", "good"); retailPartners(); } catch (err) { toast(err.message, "bad"); }
  }));
}

// Staff change their own password here, inside the admin portal.
async function myPassword() {
  const u = await me(true);
  render(main, html`${head("My password", `Signed in as ${u.email}. Other devices are signed out when you change it.`)}
    <section class="card" style="max-width:520px"><form class="stack" id="pw">
      <div class="field"><label for="cp">Current password</label><input id="cp" name="currentPassword" type="password" required autocomplete="current-password"></div>
      <div class="field"><label for="np">New password</label><input id="np" name="newPassword" type="password" required minlength="14" autocomplete="new-password"><span class="hint">At least 14 characters.</span></div>
      <div class="field"><label for="np2">Confirm new password</label><input id="np2" name="newPasswordConfirm" type="password" required minlength="14" autocomplete="new-password"></div>
      <button class="btn btn-dark">Change password</button></form></section>`);
  onSubmit($("#pw"), async (v, f) => { await post("/api/auth/me/password", matchPasswords(v, "newPassword", "newPasswordConfirm")); f.reset(); $(".pw-nag")?.remove(); toast("Password changed.", "good"); });
}
const act = async (fn, msg = "Done.") => { try { await fn(); toast(msg, "good"); return true; } catch (err) { toast(err.message, "bad"); return false; } };
const reason = (title, msg, label = "Reason") => confirmDialog(title, msg, { confirm: "Confirm", input: { label, required: true } });

function nav(counts = {}) {
  const c = (n) => (n ? html`<span class="count">${n}</span>` : "");
  render($("#sidenav"), html`<a href="#/">Overview</a>
    <div class="sect">Operations</div><a href="#/organisers">Organiser accounts${c(counts.orgs)}</a><a href="#/verification">Verification${c(counts.verif)}</a><a href="#/retail-partners" data-role-need="admin finance support">Retail partners</a><a href="#/events">All events${c(counts.events)}</a><a href="#/event-changes" data-role-need="admin">Event change requests${c(counts.eventChanges)}</a><a href="#/promo-codes" data-role-need="admin">Promo codes & vouchers</a><a href="#/events" data-featured-nav data-role-need="admin">Featured events</a><a href="#/users" data-role-need="admin support">Customers & organisers</a><a href="#/lookup">Orders & tickets</a><a href="#/tags" data-feature="tags">Tags</a><a href="#/terminals" data-feature="pos">Terminals</a><a href="#/wallets" data-feature="cashDesk">Wristbands & wallets</a><a href="#/support">Support${c(counts.support)}</a><a href="#/promotions" data-feature="promote">Promotions${c(counts.promotions)}</a>
    <div class="sect" data-feature="finance" data-role-need="admin finance">Finance</div><a href="#/refunds" data-feature="finance" data-role-need="admin finance">Refunds${c(counts.refunds)}</a><a href="#/payouts" data-feature="finance" data-role-need="admin finance">Payouts${c(counts.payouts)}</a><a href="#/payments" data-feature="finance" data-role-need="admin finance">Payments & webhooks</a><a href="#/reconciliation" data-feature="finance" data-role-need="admin finance">Reconciliation${c(counts.recon)}</a><a href="#/ledger" data-feature="finance" data-role-need="admin finance">Ledger</a>
    <div class="sect">Website</div><a href="#/site">Site settings</a><a href="#/posters">Advertising posters</a><a href="#/careers" data-role-need="admin">Careers</a><a href="#/subscribers" data-role-need="admin support">Subscribers</a><a href="#/qr">QR codes</a><a href="#/assistant">Assistant</a><a href="#/emails">Email templates</a>
    <div class="sect">Governance</div><a href="#/integrations" data-role-need="admin">Integrations</a><a href="#/backups" data-role-need="admin">Backups</a><a href="#/audit">Audit log</a><a href="#/outbox">Messages</a>
    <div class="sect">You</div><a href="#/staff">Staff & roles</a><a href="#/password">My password</a>`);
  // Each person sees only the sections their roles can open.
  $$("#sidenav [data-role-need]").forEach((a) => { if (!a.dataset.roleNeed.split(" ").some((r) => R.has(r))) a.remove(); });
  $("#sidenav [data-featured-nav]")?.addEventListener("click", () => {
    sessionStorage.setItem("adm_ev", "featured");
    if (location.hash.startsWith("#/events")) events();
  });
}

async function overview() {
  const d = await get("/api/admin/dashboard");
  nav({ orgs: d.organisers.pending, verif: d.ops.verification_pending, events: d.events.pending + d.events.cancel_requests, eventChanges: d.events.change_requests, refunds: d.ops.refunds_pending, payouts: d.ops.payouts_open, recon: d.ops.recon_exceptions, support: d.ops.support_open, promotions: d.ops.promotions_social });
  // text is [one, many]: "1 refund awaiting…", "3 refunds awaiting…".
  const alert = (n, text, href, kind = "warn") => n ? html`<a class="attn ${kind}" href="${href}"><span class="n">${n}</span><span class="t">${n === 1 ? text[0] : text[1]}</span><span class="go" aria-hidden="true">›</span></a>` : "";
  // Which build is running, so an upload can be checked at a glance.
  const build = await fetch("/version.txt", { cache: "no-store" }).then((r) => (r.ok ? r.text() : "")).then((t) => (t.match(/build (\S+)/) || [])[1] || "").catch(() => "");
  render(main, html`${head("Overview", `Signed in as ${[...R].join(", ")}.${build ? ` Running build ${build}.` : ""}`)}
    <div class="kpis"><div class="kpi"><div class="k">GMV (24h)</div><div class="v">${moneyExact(d.sales.gmv24)}</div><div class="s">${plural(d.sales.orders24, "order")}</div></div>
      <div class="kpi"><div class="k">GMV (all time)</div><div class="v">${moneyExact(d.sales.gmv_all)}</div></div>
      <div class="kpi"><div class="k">Users</div><div class="v">${d.users.total}</div><div class="s">+${d.users.new7} this week</div></div>
      <div class="kpi"><div class="k">Live events</div><div class="v">${d.events.live}</div><div class="s">${plural(d.organisers.approved, "approved organiser")}</div></div></div>
    <section class="card mt"><h2>Needs attention</h2><div class="attn-list">
      ${d.ops.payments_test ? html`<a class="attn warn" href="#/integrations"><span class="n">TEST</span><span class="t">Payments are in test mode<small>Buyers pay with practice payments and get TEST tickets the gate refuses${d.ops.test_orders ? ` (${d.ops.test_orders} so far)` : ""}. Switch to Live in Integrations before tickets go on sale.</small></span><span class="go" aria-hidden="true">›</span></a>` : ""}
      ${alert(d.organisers.pending, ["organiser awaiting approval", "organisers awaiting approval"], "#/organisers")}
      ${alert(d.ops.verification_pending, ["verification document waiting for a check", "verification documents waiting for a check"], "#/verification")}
      ${alert(d.events.pending, ["event awaiting approval", "events awaiting approval"], "#/events")}
      ${alert(d.events.cancel_requests, ["event cancellation request", "event cancellation requests"], "#/events")}
      ${alert(d.events.change_requests, ["event change request", "event change requests"], "#/event-changes")}
      ${alert(d.ops.refunds_pending, ["refund awaiting finance approval", "refunds awaiting finance approval"], "#/refunds")}
      ${alert(d.ops.refunds_failed, ["refund failed at the provider", "refunds failed at the provider"], "#/refunds", "bad")}
      ${alert(d.ops.payouts_open, ["payout open", "payouts open"], "#/payouts")}
      ${alert(d.ops.unfulfilled, ["paid order without tickets (refund raised)", "paid orders without tickets (refund raised)"], "#/lookup", "bad")}
      ${alert(d.ops.webhook_problems, ["payment notification failed or rejected in 24h", "payment notifications failed or rejected in 24h"], "#/payments", "bad")}
      ${alert(d.ops.stale_payments, ["payment pending for more than 30 minutes. Check it with the provider", "payments pending for more than 30 minutes. Check them with the provider"], "#/payments")}
      ${alert(d.ops.recon_exceptions, ["unresolved reconciliation exception", "unresolved reconciliation exceptions"], "#/reconciliation", "bad")}
      ${alert(d.ops.messages_failed, ["message failed to send", "messages failed to send"], "#/outbox", "bad")}
      ${alert(d.ops.support_open, ["open support case", "open support cases"], "#/support")}
      ${Object.values(d.ops).every((x) => !x) && !d.organisers.pending && !d.events.pending ? html`<p class="callout good mb-0">All clear.</p>` : ""}</div></section>
    <section class="card mt"><h2>Ledger integrity</h2><p class="${d.ledger.balanced ? "callout good" : "callout bad"}">${d.ledger.balanced ? `Balanced: ${d.ledger.entries} entries sum to R0.00.` : `UNBALANCED. Investigate journals ${d.ledger.unbalancedJournals.join(", ")}`}</p>
      ${tbl(["Provider clearing", "#Ledger", "#Expected", "Check"], d.ledger.clearing.map((c) => html`<tr><td title="${c.account}">${accountName(c.account)}</td><td class="num">${moneyExact(c.ledgerCents)}</td><td class="num">${moneyExact(c.expectedCents)}</td><td>${badge(c.ok ? "matched" : "failed")}</td></tr>`))}
      ${moneyFindings(d.ledger.exceptions)}</section>`);
}

// A search box for the organiser and event lists, remembered for the session.
const searchBox = (key, q, placeholder) => html`<form class="row mb" data-search="${key}"><input class="grow" name="q" value="${q}" placeholder="${placeholder}" aria-label="${placeholder}" maxlength="80">
  <button class="btn btn-ghost">Search</button>${q ? html`<button type="button" class="btn btn-link" data-clear>Clear</button>` : ""}</form>`;
function wireSearch(key, redraw) {
  const f = $(`[data-search="${key}"]`);
  f.addEventListener("submit", (e) => { e.preventDefault(); sessionStorage.setItem(`adm_${key}`, f.elements.q.value.trim()); redraw(); });
  $("[data-clear]", f)?.addEventListener("click", () => { sessionStorage.removeItem(`adm_${key}`); redraw(); });
}

async function organisers() {
  const q = sessionStorage.getItem("adm_oq") || "";
  const { organisers: list } = await get(`/api/admin/organisers${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  render(main, html`${head("Organiser accounts", "Organisations that sell tickets on TicketRoom. Approve applications here; organisers run their own events in the organiser portal.")}
    ${searchBox("oq", q, "Search by organiser ID (ORG-…), name or email")}
    ${tbl(["Organiser", "Owner", "Contact", "Events", "Bank", "Verification", "Status", ""], list.map((o) => html`<tr><td><a href="#/organisers/${o.id}"><strong>${o.name}</strong></a><div class="tiny muted"><span class="mono">${o.ref || ""}</span> · ${fmtDate(o.created_at)}</div></td><td>${o.owner_name || ""}</td><td class="small">${o.contact_email}<br>${o.contact_phone || ""}</td><td>${o.events}</td><td>${o.bank_account_last4 ? `••${o.bank_account_last4}` : "–"}</td>
    <td>${badge(o.verification)}${o.verification_pending ? html`<div class="tiny muted">${o.verification_pending} to check</div>` : ""}</td><td>${badge(o.status)}<div class="tiny muted">${o.commission_bps == null ? "standard fee" : `fee ${o.commission_bps / 100}%`}</div></td>
    <td>${isA() ? html`<div class="row"><a class="btn btn-ghost btn-sm" href="#/organisers/${o.id}">Details</a><button class="btn btn-ghost btn-sm" data-fee="${o.id}">Fee</button>${o.status !== "approved" ? html`<button class="btn btn-good btn-sm" data-s="approved" data-id="${o.id}">Approve</button>` : ""}${o.status === "pending" ? html`<button class="btn btn-ghost btn-sm" data-s="rejected" data-id="${o.id}">Reject</button>` : ""}${o.status === "approved" ? html`<button class="btn btn-ghost btn-sm" data-s="suspended" data-id="${o.id}">Suspend</button>` : ""}</div>` : ""}</td></tr>`), q ? "No organiser matches that search." : "No organisers yet. When someone applies to sell tickets, their application appears here for approval.")}`);
  wireSearch("oq", organisers);
  $$("[data-s]").forEach((b) => b.addEventListener("click", async () => {
    const why = b.dataset.s === "approved" ? "" : await reason(`${b.dataset.s === "rejected" ? "Reject" : "Suspend"} organiser`, b.dataset.s === "suspended" ? "Their published events will be suspended too." : "They will be told.");
    if (why === false) return;
    if (await act(() => post(`/api/admin/organisers/${b.dataset.id}/status`, { status: b.dataset.s, reason: why || undefined }))) organisers();
  }));
  $$("[data-fee]").forEach((b) => b.addEventListener("click", async () => {
    const cfg = await get("/api/config");
    const standard = (Number(cfg.fees?.organiserCommissionBps ?? 500) / 100).toString();
    const v = await confirmDialog("Organiser commission", `Percentage component of the organiser commission. The standard flat amount per paid ticket still applies. Leave empty for the current standard rate (${standard}%). Applies to new orders only.`, { confirm: "Save", input: { label: "Commission %", placeholder: standard } });
    if (v === false) return;
    const pct = v === true || v === "" ? null : Number(String(v).replace(",", "."));
    if (pct !== null && !(pct >= 0 && pct <= 50)) return toast("Enter a percentage between 0 and 50.", "bad");
    if (await act(() => post(`/api/admin/organisers/${b.dataset.fee}/commission`, { commissionBps: pct === null ? undefined : Math.round(pct * 100) }), "Commission saved.")) organisers();
  }));
}

async function events() {
  const filter = sessionStorage.getItem("adm_ev") || "pending_approval";
  const q = sessionStorage.getItem("adm_eq") || "";
  // A search looks through every event, whatever its status.
  const query = new URLSearchParams();
  if (q) query.set("q", q);
  if (filter === "featured") query.set("featured", "1");
  else if (!q && filter !== "all") query.set("status", filter);
  const { events: list } = await get(`/api/admin/events${query.size ? `?${query}` : ""}`);
  render(main, html`${head(filter === "featured" ? "Featured events" : "All events", filter === "featured" ? "Only staff can choose which events appear in TicketRoom’s featured rail. Add placements from All events; remove them here." : "Every event on TicketRoom, from every organiser. Approve, suspend or handle cancellation requests.")}
    ${searchBox("eq", q, "Search by event ID (EV-…), organiser ID, event or organiser name")}<div class="chips ${q ? "hidden" : ""}">${[["pending_approval", "Awaiting approval"], ["cancel_requests", "Cancellation requests"], ["published", "Published"], ["suspended", "Suspended"], ["featured", "Featured"], ["all", "All"]].map(([k, l]) => html`<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`)}</div>
    <div class="mt">${tbl(["Event", "Organiser", "Date", "Sold", "Status", ""], list.map((e) => html`<tr><td><strong>${e.title}</strong><div class="tiny muted mono">${e.ref || ""}</div>${e.cancellation_requested_at && e.status !== "cancelled" ? html`<div class="small" >Cancellation requested: ${e.cancellation_reason}</div>` : ""}${e.featured ? html` <span class="badge amber plain">Featured</span>` : ""}</td><td>${e.organiser_name}<div class="tiny muted mono">${e.organiser_ref || ""}</div></td><td>${fmtDate(e.starts_at)}<div class="tiny muted">${e.city}</div></td><td>${e.sold}/${e.capacity}</td><td>${badge(e.status)}</td>
      <td>${isA() ? html`<div class="row">
        ${e.status === "pending_approval" ? html`<button class="btn btn-good btn-sm" data-a="publish" data-id="${e.id}">Publish</button><button class="btn btn-ghost btn-sm" data-a="reject" data-id="${e.id}">Request changes</button>` : ""}
        ${e.status === "published" ? html`<button class="btn btn-ghost btn-sm" data-a="${e.featured ? "unfeature" : "feature"}" data-id="${e.id}">${e.featured ? "Unfeature" : "Feature"}</button><button class="btn btn-ghost btn-sm" data-a="suspend" data-id="${e.id}">Suspend</button>` : ""}
        ${e.status === "suspended" ? html`<button class="btn btn-ghost btn-sm" data-a="reinstate" data-id="${e.id}">Reinstate</button>` : ""}
        ${!["cancelled", "completed", "draft"].includes(e.status) ? html`<button class="btn btn-danger btn-sm" data-cancel="${e.id}">Cancel & refund</button>` : ""}
        <a class="btn btn-link btn-sm" href="/events/${e.slug}" target="_blank">view</a></div>` : ""}</td></tr>`))}</div>`);
  wireSearch("eq", events);
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
    try { const r = await post(`/api/admin/events/${b.dataset.cancel}/cancel`, { reason: why }); toast(`Event cancelled. ${r.refundsRaised} refunds raised for finance.${r.unpaidCancelled ? ` ${r.unpaidCancelled} unpaid order${r.unpaidCancelled === 1 ? "" : "s"} cancelled.` : ""}${r.skipped?.length ? ` Not raised yet: ${r.skipped.map((x) => `${x.reference} (${x.reason})`).join("; ")}` : ""}`, r.skipped?.length ? "bad" : "good"); events(); } catch (err) { toast(err.message, "bad"); }
  }));
}

async function eventChangeRequests() {
  if (!isA()) return render(main, html`<div class="card"><h1>Not found</h1><p class="mb-0">That page doesn't exist.</p></div>`);
  const filter = sessionStorage.getItem("adm_event_changes") || "pending";
  const { requests } = await get(`/api/admin/event-change-requests?status=${filter}`);
  const labels = { title: "Event name", summary: "Summary", description: "Description", category: "Category", venueName: "Venue", address: "Street address", city: "City", province: "Province", startsAt: "Starts", endsAt: "Ends", capacity: "Capacity", salesStartAt: "Sales open", salesEndAt: "Sales close", doorsOpenAt: "Doors open", parkRideInfo: "Park and ride details", parkRideUrl: "Park and ride link", refundPolicy: "Refund policy", accessibilityInfo: "Accessibility", ageRestriction: "Age restriction", transfersEnabled: "Ticket transfers", resaleEnabled: "Fan resale", cashlessEnabled: "Cashless", isFree: "Free event", serviceFeePayer: "Service fee payer", ageGroups: "Audience", lineup: "Line-up", presaleQueueEnabled: "Presale queue", imageUploadId: "Poster image", name: "Ticket name", description: "Ticket description", priceCents: "Price", quantityTotal: "Quantity", perOrderLimit: "Per order", salesStartAt: "Sales open", salesEndAt: "Sales close", status: "Sale status", sortOrder: "Display order", kind: "Ticket kind", admits: "People per ticket" };
  const show = (key, value) => {
    if (value === null || value === undefined || value === "") return "—";
    if (["isFree", "transfersEnabled", "resaleEnabled", "cashlessEnabled", "presaleQueueEnabled"].includes(key)) return value ? "Yes" : "No";
    if (["startsAt", "endsAt", "salesStartAt", "salesEndAt", "doorsOpenAt"].includes(key)) return fmtDateTime(value);
    if (key === "priceCents") return moneyExact(value);
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  const rows = (changes, before, group = "event") => Object.entries(changes || {}).map(([k, v]) => html`<tr><th>${labels[k] || k}</th><td>${show(k, before?.[k])}</td><td><strong>${show(k, v)}</strong></td></tr>`);
  render(main, html`${head("Event change requests", "Review proposed changes before they alter a live event. Check the evidence, remaining inventory, current orders and impact on ticket holders.")}
    <div class="chips"><button class="chip" data-change-filter="pending" aria-pressed="${filter === "pending"}">Awaiting review</button><button class="chip" data-change-filter="reviewed" aria-pressed="${filter === "reviewed"}">Reviewed</button><button class="chip" data-change-filter="all" aria-pressed="${filter === "all"}">All requests</button></div>
    ${requests.length ? html`<div class="stack mt">${requests.map((r) => {
      const eventChanges = r.changes?.event || {};
      const ticketChange = r.changes?.ticketType;
      const beforeTicket = r.before?.ticketType?.fields || {};
      const pending = r.status === "pending";
      const material = ["title", "startsAt", "endsAt", "venueName", "address", "city", "province"].some((key) => Object.prototype.hasOwnProperty.call(eventChanges, key));
      return html`<section class="card stack"><div class="row between"><div><h2 class="mb-0">${r.event_title}</h2><p class="small muted mb-0">${r.organiser_name} · requested by ${r.requester_name} · ${fmtDateTime(r.created_at)}</p></div>${badge(r.status)}</div>
        <p class="mb-0">${r.request_reason}</p>
        ${Object.keys(eventChanges).length ? html`<div><h3>Event details</h3>${tbl(["Field", "Current", "Proposed"], rows(eventChanges, r.before?.event))}</div>` : ""}
        ${ticketChange ? html`<div><h3>${ticketChange.id ? "Ticket type changes" : "Proposed new ticket type"}</h3>${tbl(["Field", "Current", "Proposed"], rows(ticketChange.changes, beforeTicket, "ticket"))}</div>` : ""}
        <div class="kpis"><div class="kpi"><div class="k">Tickets sold or held</div><div class="v">${r.tickets_committed}</div></div><div class="kpi"><div class="k">Ticket holders</div><div class="v">${r.ticket_holders}</div></div><div class="kpi"><div class="k">Open checkouts</div><div class="v">${r.pending_orders}</div></div><div class="kpi"><div class="k">Open refunds</div><div class="v">${r.open_refunds}</div></div></div>
        ${material && r.pending_orders ? html`<p class="callout warn mb-0">There are pending checkouts. The API will block approval of a date or venue change until these expire or are resolved.</p>` : ""}
        ${pending ? html`<form class="card flat stack" data-event-change-review="${r.id}"><h3 class="mb-0">Admin review</h3>
          <label class="check"><input type="checkbox" name="eventDetailsVerified"><span>Event details are supported and verified against the organiser’s information.</span></label>
          <label class="check"><input type="checkbox" name="inventoryAndOrdersChecked"><span>Ticket capacity, sold and reserved inventory, open checkouts, refunds and any pricing impact have been checked.</span></label>
          <label class="check"><input type="checkbox" name="attendeeImpactReviewed"><span>Ticket-holder impact has been reviewed, with an appropriate notice and customer-support plan for material changes.</span></label>
          <label class="check"><input type="checkbox" name="complianceAndOperationsChecked"><span>Safety, permits, age restrictions and event operations remain appropriate after the change.</span></label>
          <div class="field"><label for="review-note-${r.id}">Review note <span class="muted">(required for approval or rejection)</span></label><textarea id="review-note-${r.id}" name="reviewNote" required minlength="10" maxlength="1500" rows="3" placeholder="Record what you checked and why you are approving or rejecting this request."></textarea></div>
          <div class="row"><button type="button" class="btn btn-good" data-change-review-action="approve" data-id="${r.id}">Approve and apply</button><button type="button" class="btn btn-ghost" data-change-review-action="reject" data-id="${r.id}">Reject request</button><a class="btn btn-link" href="/events/${r.event_slug}" target="_blank">View current public event ↗</a></div></form>` : html`<div class="card flat"><p class="small mb-0"><strong>Admin note:</strong> ${r.review_note || "No note recorded."}${r.reviewed_at ? ` · ${fmtDateTime(r.reviewed_at)}` : ""}</p></div>`}
      </section>`;
    })}</div>` : empty(filter === "pending" ? "No event change requests are awaiting review." : "No event change requests found.")}`);
  $$('[data-change-filter]').forEach((b) => b.addEventListener("click", () => { sessionStorage.setItem("adm_event_changes", b.dataset.changeFilter); eventChangeRequests(); }));
  $$('[data-change-review-action]').forEach((b) => b.addEventListener("click", async () => {
    const form = $(`[data-event-change-review="${b.dataset.id}"]`);
    const note = form.elements.reviewNote.value.trim();
    if (note.length < 10) return toast("Add a review note of at least 10 characters.", "bad");
    const checks = Object.fromEntries(["eventDetailsVerified", "inventoryAndOrdersChecked", "attendeeImpactReviewed", "complianceAndOperationsChecked"].map((name) => [name, form.elements[name].checked]));
    if (b.dataset.changeReviewAction === "approve" && Object.values(checks).some((value) => !value)) return toast("Complete every review check before approving.", "bad");
    if (b.dataset.changeReviewAction === "reject" && !(await confirmDialog("Reject this change request?", "The current live event and ticket setup will remain unchanged.", { confirm: "Reject request", danger: true }))) return;
    try {
      const result = await post(`/api/admin/event-change-requests/${b.dataset.id}/review`, { action: b.dataset.changeReviewAction, reviewNote: note, checks });
      toast(result.status === "approved" ? (result.attendeeNoticeSent ? "Changes applied; ticket-holder notices have been queued." : "Changes approved and applied.") : "Request rejected. The live event was not changed.", "good");
      eventChangeRequests();
    } catch (err) { toast(err.message, "bad"); }
  }));
}

// Admin-created discounts remain event-bound and use the same server-side
// quote, usage limits and order snapshots as organiser-created codes.
async function promoCodes() {
  if (!isA()) return render(main, html`<div class="card"><h1>Not found</h1><p class="mb-0">That page doesn't exist.</p></div>`);
  const [{ events: eventList }, { promoCodes: list }] = await Promise.all([get("/api/admin/events"), get("/api/admin/promo-codes")]);
  render(main, html`${head("Promo codes & vouchers", "Create event-specific discounts, set clear redemption rules, and disable a code without changing existing orders.")}
    <section class="card stack"><h2>Create a code</h2><p class="small muted mb-0">Vouchers default to one redemption total and one use per email. All limits and dates are enforced by checkout. Existing orders keep their recorded totals if a code is later disabled.</p>
      ${eventList.length ? html`<form class="stack" id="acpf"><div class="field"><label for="ape">Event</label><select id="ape" name="eventId" required>${eventList.map((e) => html`<option value="${e.id}">${e.title} · ${e.organiser_name} · ${e.status}</option>`)}</select></div>
        <div class="grid-2"><div class="field"><label for="apct">Code type</label><select id="apct" name="codeType"><option value="promo">Promo code</option><option value="voucher">Voucher</option></select></div><div class="field"><label for="apc">Code</label><div class="row"><input id="apc" name="code" required minlength="3" maxlength="30" class="mono grow" autocomplete="off" placeholder="WELCOME10"><button type="button" class="btn btn-ghost btn-sm" data-admin-gen-voucher>Generate</button></div><span class="hint">Voucher codes need at least 14 characters. Generate makes a private random code.</span></div></div>
        <div class="grid-2"><div class="field"><label for="apk">Discount type</label><select id="apk" name="kind"><option value="percent">Percentage off</option><option value="fixed">Rand amount off</option></select></div><div class="field"><label for="apv">Discount value</label><input id="apv" name="value" inputmode="decimal" required placeholder="10"></div></div>
        <div class="grid-2"><div class="field"><label for="apmu">Total uses</label><input id="apmu" name="maxUses" type="number" min="1" max="100000" placeholder="Unlimited"><span class="hint">Single-use vouchers default to 1.</span></div><div class="field"><label for="apme">Uses per email</label><input id="apme" name="maxUsesPerEmail" type="number" min="1" max="100000" placeholder="Unlimited"></div></div>
        <div class="grid-2"><div class="field"><label for="apmin">Minimum ticket subtotal (R)</label><input id="apmin" name="minimumSubtotal" inputmode="decimal" placeholder="No minimum"></div><div class="field"><label for="apfrom">Starts <span class="muted">(optional)</span></label><input id="apfrom" name="validFrom" type="datetime-local"></div></div>
        <div class="field"><label for="apto">Expires <span class="muted">(optional)</span></label><input id="apto" name="validTo" type="datetime-local"></div>
        <button class="btn btn-primary">Create code</button></form>` : html`<p class="callout warn mb-0">There are no events to attach a code to yet.</p>`}</section>
    <section class="mt"><h2>Codes and vouchers</h2>${tbl(["Code", "Event / organiser", "Discount", "Uses", "Rules", "Status", ""], list.map((p) => html`<tr><td class="mono">${p.code}<div class="tiny muted">${p.code_type === "voucher" ? "Voucher" : "Promo code"}</div></td><td>${p.event_title}<div class="tiny muted">${p.organiser_name} · ${p.event_ref}</div></td><td>${p.kind === "percent" ? `${p.value}%` : moneyExact(p.value)}</td><td>${p.used_count}${p.max_uses ? `/${p.max_uses}` : " · unlimited"}<div class="tiny muted">${p.max_uses_per_email ? `${p.max_uses_per_email} per email` : "No email limit"}</div></td><td class="small">${Number(p.minimum_subtotal_cents) ? `Min. ${moneyExact(p.minimum_subtotal_cents)} · ` : ""}${p.valid_from ? fmtDateTime(p.valid_from) : "Now"}<br>${p.valid_to ? `until ${fmtDateTime(p.valid_to)}` : "No expiry"}</td><td>${badge(p.active ? "active" : "disabled")}</td><td>${p.active ? html`<button class="btn btn-ghost btn-sm" data-promo-toggle="${p.id}">Disable</button>` : html`<button class="btn btn-ghost btn-sm" data-promo-toggle="${p.id}" data-active="false">Enable</button>`}</td></tr>`), "No codes or vouchers have been created.")}</section>`);
  const f = $("#acpf");
  if (f) {
    $("#apct").addEventListener("change", (e) => { const voucher = e.target.value === "voucher"; $("#apc").minLength = voucher ? 14 : 3; $("#apc").placeholder = voucher ? "Generate a secure code" : "WELCOME10"; if (voucher) { if (!$("#apmu").value) $("#apmu").value = "1"; if (!$("#apme").value) $("#apme").value = "1"; } });
    $(`[data-admin-gen-voucher]`).addEventListener("click", () => {
      if (!globalThis.crypto?.getRandomValues) return toast("Secure code generation is unavailable in this browser. Use a secure browser connection.", "bad");
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", bytes = crypto.getRandomValues(new Uint8Array(14));
      $("#apc").value = Array.from(bytes, (b) => alphabet[b & 31]).join("");
      $("#apct").value = "voucher"; $("#apc").minLength = 14; $("#apmu").value ||= "1"; $("#apme").value ||= "1";
    });
    onSubmit(f, async (v) => {
      const value = v.kind === "percent" ? Number(v.value) : parseRand(v.value);
      const minimumSubtotalCents = v.minimumSubtotal ? parseRand(v.minimumSubtotal) : undefined;
      if (value === null || (v.minimumSubtotal && minimumSubtotalCents === null)) throw Object.assign(new Error("Check the discount and minimum spend."), { details: { value: "Enter a valid amount.", minimumSubtotal: "Enter a valid amount or leave blank." } });
      await post("/api/admin/promo-codes", { eventId: v.eventId, code: v.code, codeType: v.codeType, kind: v.kind, value,
        maxUses: v.maxUses ? Number(v.maxUses) : undefined, maxUsesPerEmail: v.maxUsesPerEmail ? Number(v.maxUsesPerEmail) : undefined,
        minimumSubtotalCents, validFrom: v.validFrom ? new Date(v.validFrom).toISOString() : undefined, validTo: v.validTo ? new Date(v.validTo).toISOString() : undefined });
      toast(`${v.codeType === "voucher" ? "Voucher" : "Promo code"} created.`, "good"); promoCodes();
    });
  }
  $$('[data-promo-toggle]').forEach((b) => b.addEventListener("click", async () => {
    if (await act(() => patch(`/api/admin/promo-codes/${b.dataset.promoToggle}`, { active: b.dataset.active === "false" }), b.dataset.active === "false" ? "Code enabled." : "Code disabled.")) promoCodes();
  }));
}

// Customers and organisers. TicketRoom staff are only under Staff & roles,
// and nothing here can turn a customer or organiser into staff.
async function users(params, type = "") {
  const draw = async (q = "") => {
    const { users: list, counts } = await get(`/api/admin/users?q=${encodeURIComponent(q)}&type=${type}`);
    $$("[data-type]").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.type === type)); const n = b.dataset.type ? counts[b.dataset.type] || 0 : (counts.customer || 0) + (counts.organiser || 0); $(".n", b).textContent = n; });
    render($("#ul"), tbl(["Name", "Email", "Type", "Status", ""], list.map((u) => html`<tr><td>${u.full_name}${u.organisations ? html`<br><span class="tiny muted">${u.organisations}</span>` : ""}</td>
      <td>${u.email}${u.guest ? html` <span class="tiny muted">(guest buyer)</span>` : u.email_verified_at ? "" : html` <span class="tiny muted">(unconfirmed)</span>`}</td>
      <td><span class="badge ${u.account_type === "organiser" ? "info" : "plain"}">${u.account_type === "organiser" ? "Organiser" : "Customer"}</span></td><td>${badge(u.status)}</td>
      <td><button class="btn btn-ghost btn-sm" data-u="${u.id}">Open</button></td></tr>`), "Nobody matches that search."));
    $$("[data-u]").forEach((b) => b.addEventListener("click", () => userDialog(b.dataset.u, () => draw(q))));
  };
  render(main, html`${head("Customers & organisers", "Everyone who buys tickets or runs events. TicketRoom staff are managed under Staff & roles.")}
    <div class="row chip-select mb" role="group" aria-label="Show">${[["", "Everyone"], ["customer", "Customers"], ["organiser", "Organisers"]].map(([k, l]) => html`<button type="button" class="chip" data-type="${k}" aria-pressed="${k === type}">${l} <span class="n">·</span></button>`)}</div>
    <form class="row" id="us"><input id="uq" class="grow" placeholder="Search name, email or phone" aria-label="Search"><button class="btn btn-ghost">Search</button></form><div id="ul" class="mt">${spinner()}</div>`);
  $("#us").addEventListener("submit", (e) => { e.preventDefault(); draw($("#uq").value); });
  $$("[data-type]").forEach((b) => b.addEventListener("click", () => { type = b.dataset.type; draw($("#uq").value); }));
  draw();
}

async function userDialog(id, done) {
  const d = await get(`/api/admin/users/${id}`);
  const u = d.user;
  const kind = u.account_type === "organiser" ? "Organiser account" : u.guest ? "Guest buyer (no password yet)" : "Customer account";
  const dlg = dialog(u.full_name, html`<p class="small">${kind} · ${u.email} · ${u.phone || "no phone"} · joined ${fmtDate(u.created_at)} · ${badge(u.status)}</p>
    ${isA() ? html`<div class="row">${u.status === "active" ? html`<button class="btn btn-danger btn-sm" data-st="suspended">Suspend account</button>` : u.status === "suspended" ? html`<button class="btn btn-good btn-sm" data-st="active">Reactivate account</button>` : ""}</div>` : ""}
    ${d.organisations?.length ? html`<h3 class="mt">Organisations</h3>${tbl(["Organisation", "ID", "Role", "Status"], d.organisations.map((o) => html`<tr><td>${o.name}</td><td class="mono small">${o.ref || ""}</td><td>${o.role}</td><td>${badge(o.status)}</td></tr>`))}` : ""}
    ${u.account_type === "organiser" ? "" : html`<h3 class="mt">Orders</h3>${tbl(["Ref", "Event", "Status", "#Total"], d.orders.map((o) => html`<tr><td class="mono">${o.reference}</td><td>${o.title}</td><td>${badge(o.status)}</td><td class="num">${moneyExact(o.total_cents)}</td></tr>`))}
    <h3 class="mt">Tickets</h3>${tbl(["Code", "Event", "Status"], d.tickets.map((t) => html`<tr><td class="mono">${t.code}</td><td>${t.title}</td><td>${badge(t.status)}</td></tr>`))}`}`, { wide: true, onClose: done });
  $$("[data-st]", dlg).forEach((b) => b.addEventListener("click", async () => { const why = await reason(b.dataset.st === "suspended" ? "Suspend this account?" : "Reactivate this account?", "They are signed out straight away if suspended. This is logged."); if (why && await act(() => post(`/api/admin/users/${id}/status`, { status: b.dataset.st, reason: why }))) dlg.close(); }));
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
    render($("#res"), tbl(["Ref", "Buyer", "Event", "#Total", "Status", "Payments", ""], orders.map((o) => html`<tr><td class="mono">${o.reference}</td><td>${o.buyer_name}<div class="tiny muted">${o.buyer_email}</div></td><td>${o.title}</td><td class="num">${moneyExact(o.total_cents)}${o.refunded_cents ? html`<div class="tiny">refunded ${moneyExact(o.refunded_cents)}</div>` : ""}</td><td>${badge(o.status)}</td>
      <td class="small">${(o.payments || []).map((p) => html`<div>${p.provider} <span class="mono">${p.ref || "–"}</span> ${badge(p.status)}</div>`)}</td>
      <td>${["paid", "partially_refunded"].includes(o.status) && o.total_cents > o.refunded_cents && (o.payments || []).length ? html`<button class="btn btn-ghost btn-sm" data-refund="${o.reference}">Refund</button>` : ""}</td></tr>`)));
    // Customer care raises the refund; finance approves it (two people, as always).
    $$("[data-refund]").forEach((b) => b.addEventListener("click", () => {
      const dlg = dialog(`Refund ${b.dataset.refund}`, html`<form class="stack"><p class="mb-0">Refunds every unrefunded ticket on this order. Finance approves it, then the money goes back to the buyer's card.</p>
        <div class="field"><label for="rr">Reason</label><input id="rr" name="reason" required minlength="3" maxlength="400" placeholder="e.g. Customer can't attend, organiser agreed"></div>
        <label class="check"><input type="checkbox" name="includeFees"><span>Refund the service fee too</span></label><button class="btn btn-dark">Ask finance to refund</button></form>`);
      onSubmit($("form", dlg), async (v) => { const r = await post(`/api/admin/orders/${b.dataset.refund}/refund`, { reason: v.reason, includeFees: !!v.includeFees }); dlg.close(); toast(`Refund ${r.refund.reference} (${moneyExact(r.refund.amountCents)}) is waiting for finance.`, "good"); });
    }));
  });
}

async function refunds() {
  const filter = sessionStorage.getItem("adm_rf") || "requested";
  const { refunds: list } = await get(`/api/admin/refunds${filter === "all" ? "" : `?status=${filter}`}`);
  const actionable = list.filter((r) => r.status === "requested" && !r.mine);
  render(main, html`${head("Refunds", "Every refund needs a second person: you cannot approve a refund you requested.", isF() && filter === "requested" && actionable.length ? html`<button class="btn btn-good" data-bulk>Approve all ${actionable.length} I can</button>` : "")}
    ${!isF() ? html`<p class="callout">View only. Approving refunds needs the finance role.</p>` : ""}
    <div class="chips">${["requested", "manual_pending", "failed", "completed", "rejected", "all"].map((k) => html`<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${sentence(k)}</button>`)}</div>
    <div class="mt">${tbl(["Ref", "Event", "Type", "Reason", "By", "#Amount", "Status", ""], list.map((r) => html`<tr><td class="mono">${r.reference}${r.order_reference ? html`<div class="tiny muted">${r.order_reference}</div>` : ""}</td><td>${r.event_title}</td><td>${r.kind.replace("_", " ")}</td><td class="small">${r.reason}${r.failure_reason ? html`<div class="tiny">Failed: ${r.failure_reason}</div>` : ""}</td><td class="small">${r.requested_by_name || "system"}${r.decided_by_name ? html`<div class="tiny muted">decided: ${r.decided_by_name}</div>` : ""}</td>
      <td class="num">${moneyExact(r.amount_cents + r.fee_refund_cents)}</td><td>${badge(r.status)}</td>
      <td>${isF() && r.status === "requested" && !r.mine ? html`<div class="row"><button class="btn btn-good btn-sm" data-ok="${r.id}">Approve</button><button class="btn btn-ghost btn-sm" data-no="${r.id}">Reject</button></div>` : ""}
        ${isF() && r.status === "failed" ? html`<button class="btn btn-ghost btn-sm" data-retry="${r.id}">Retry</button>` : ""}${isF() && r.status === "manual_pending" ? html`<button class="btn btn-dark btn-sm" data-manual="${r.id}">Mark paid manually</button>` : ""}${r.mine && r.status === "requested" ? html`<span class="tiny muted">You requested this, so someone else must approve it</span>` : ""}</td></tr>`))}</div>`);
  if ((await features()).cashDesk) main.insertAdjacentHTML("beforeend", '<div id="cos"></div>'), cashouts($("#cos"));
  main.insertAdjacentHTML("beforeend", '<div id="rps"></div>'); resalePayouts($("#rps"));
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

// Promote packages: the socials queue, revenue (live and TEST kept apart)
// and refunds when an event is cancelled.
async function promotions() {
  const filter = sessionStorage.getItem("adm_pm") || "social";
  const { promotions: list, revenue: rv } = await get(`/api/admin/promotions${filter === "all" ? "" : `?status=${filter}`}`);
  const canSocial = isA() || isS();
  render(main, html`${head("Promotions", "Organisers pay once to promote an event until it ends. Post their events on our socials, and refund a package if its event is cancelled.")}
    <div class="kpis"><div class="kpi"><div class="k">Promote revenue</div><div class="v">${moneyExact(rv.liveCents)}</div><div class="s">${rv.live} paid package${rv.live === 1 ? "" : "s"}, less refunds</div></div>
      <div class="kpi"><div class="k">Test purchases</div><div class="v">${moneyExact(rv.testCents)}</div><div class="s">${rv.test} TEST package${rv.test === 1 ? "" : "s"}, never revenue</div></div>
      <div class="kpi"><div class="k">Active now</div><div class="v">${rv.active}</div><div class="s">promoted until their events end</div></div>
      <div class="kpi"><div class="k">Social posts to do</div><div class="v">${rv.socialQueue}</div><div class="s">requested or scheduled</div></div></div>
    <div class="chips mt">${[["social", "Social queue"], ["active", "Active"], ["pending_payment", "Unpaid"], ["ended", "Ended"], ["refunded", "Refunded"], ["all", "All"]].map(([k, l]) => html`<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`)}</div>
    <div class="mt">${tbl(["Ref", "Event", "Paid", "Status", "Social", ""], list.map((p) => html`<tr>
      <td class="mono small">${p.reference}${p.test ? html` <span class="badge amber">TEST</span>` : ""}</td>
      <td><a href="/events/${p.event_slug}" target="_blank" rel="noopener">${p.event_title}</a><div class="tiny muted">${p.organiser_name} · ${p.bought_by_email || ""}</div>${p.event_status === "cancelled" || p.cancellation_requested_at ? html`<div class="tiny"><span class="badge bad">Event ${p.event_status === "cancelled" ? "cancelled" : "cancellation requested"}</span></div>` : ""}</td>
      <td class="small">${moneyExact(p.price_cents)}${p.paid_at ? html`<div class="tiny muted">${p.paid_with === "balance" ? "from balance" : p.payment_provider || "card"} · ${fmtDate(p.paid_at)}</div>` : ""}</td>
      <td>${badge(p.status)}${p.status === "active" ? html`<div class="tiny muted">until ${fmtDate(p.ends_at)}</div>` : ""}${p.refund_status && p.refund_status !== "completed" ? html`<div class="tiny">refund ${p.refund_status.replace("_", " ")}${p.refund_failure ? `: ${p.refund_failure}` : ""}</div>` : ""}</td>
      <td>${p.social_status ? badge(p.social_status) : html`<span class="tiny muted">no request</span>`}</td>
      <td><div class="row">${p.social_request ? html`<button class="btn btn-ghost btn-sm" data-soc="${p.id}">${canSocial && p.social_status !== "posted" ? "Social post" : "View request"}</button>` : ""}
        ${isF() && ["active", "ended"].includes(p.status) && (p.event_status === "cancelled" || p.cancellation_requested_at) && (!p.refund_status || p.refund_status === "failed") ? html`<button class="btn btn-ghost btn-sm" data-refund="${p.id}">Refund</button>` : ""}
        ${isF() && ["manual_pending", "failed"].includes(p.refund_status) ? html`<button class="btn btn-dark btn-sm" data-manual="${p.id}">Record refund</button>` : ""}</div></td></tr>`),
      filter === "social" ? "No social posts waiting." : "No promotions here.")}</div>`);
  $$("[data-f]").forEach((b) => b.addEventListener("click", () => { sessionStorage.setItem("adm_pm", b.dataset.f); promotions(); }));
  $$("[data-refund]").forEach((b) => b.addEventListener("click", async () => {
    const why = await reason("Refund this Promote package", "The money goes back the way it was paid: card (by the provider) or the organiser's balance.");
    if (why && await act(() => post(`/api/admin/promotions/${b.dataset.refund}/refund`, { reason: why }), "Refund sent.")) promotions();
  }));
  $$("[data-manual]").forEach((b) => b.addEventListener("click", async () => {
    const ref = await reason("Record the refund", "Refund it in the provider's dashboard (PayFast or Yoco) first, then enter its reference here.", "Provider reference");
    if (ref && await act(() => post(`/api/admin/promotions/${b.dataset.manual}/refund/complete`, { providerReference: ref }), "Refund recorded.")) promotions();
  }));
  $$("[data-soc]").forEach((b) => b.addEventListener("click", () => {
    const p = list.find((x) => x.id === b.dataset.soc), r = p.social_request || {};
    const dlg = dialog(`Social post: ${p.event_title}`, html`<div class="stack">
      <p class="small muted mb-0">Asked by ${r.requestedBy || "the organiser"} on ${fmtDateTime(r.requestedAt)} · ${p.organiser_name}</p>
      <div class="card flat"><p class="mb-0 prose">${r.caption}</p></div>
      <p class="small mb-0"><strong>Preferred dates:</strong> ${r.preferredDates || "any"}</p>
      ${r.links?.length ? html`<p class="small mb-0"><strong>Their links:</strong> ${r.links.map((u) => html`<a href="${u}" target="_blank" rel="noopener">${u}</a> `)}</p>` : ""}
      ${r.images?.length ? html`<div class="row">${r.images.map((id) => html`<a href="/media/${id}" target="_blank" rel="noopener" download><img class="promote-thumb" src="/media/${id}" alt="Picture for the post"></a>`)}</div><p class="tiny muted mb-0">Open a picture to download it.</p>` : html`<p class="small muted mb-0">No pictures.</p>`}
      ${canSocial && p.social_status !== "posted" ? html`<form class="stack" id="smf"><div class="field"><label for="sms">Status</label><select id="sms" name="status"><option value="scheduled" ${raw(p.social_status !== "scheduled" ? "selected" : "")}>Scheduled</option><option value="posted" ${raw(p.social_status === "scheduled" ? "selected" : "")}>Posted (live)</option></select></div>
        <div class="field"><label for="smn">Note to the organiser <span class="muted">(optional)</span></label><input id="smn" name="notes" maxlength="1000" value="${p.social_notes || ""}" placeholder="e.g. Going out on Instagram and Facebook on Friday at 18:00"></div>
        <div class="field"><label for="sml">Post links <span class="muted">(one per line, needed for Posted)</span></label><textarea id="sml" name="links" rows="2">${(p.social_links || []).join("\n")}</textarea></div>
        <button class="btn btn-primary">Save</button><p class="tiny muted mb-0">Marking it posted emails the organiser the links.</p></form>`
        : p.social_links?.length ? html`<p class="small mb-0"><strong>Posted:</strong> ${p.social_links.map((u) => html`<a href="${u}" target="_blank" rel="noopener">${u}</a> `)}</p>` : ""}</div>`, { wide: true });
    const f = $("#smf", dlg);
    if (f) onSubmit(f, async (v) => {
      await post(`/api/admin/promotions/${p.id}/social`, { status: v.status, notes: v.notes || undefined, links: String(v.links || "").split(/\s+/).filter(Boolean) });
      dlg.close(); toast(v.status === "posted" ? "Marked as posted. The organiser has been emailed." : "Marked as scheduled.", "good"); promotions();
    });
  }));
}

async function payouts() {
  const { payouts: list, peach } = await get("/api/admin/payouts");
  const peachActive = peach?.enabled;
  const livePeach = peachActive && peach.environment === "live";
  render(main, html`${head("Payouts", livePeach ? "Approve each request, then choose whether to send it through Peach or handle the EFT manually. Peach transfers cannot be recalled." : peachActive ? "Peach is in sandbox mode. Test approved payouts against Peach’s sandbox; these tests never settle or reduce real organiser balances." : "TicketRoom does not move money automatically. Approve, make the EFT from TicketRoom's bank account, then record it here with the bank reference.")}
    ${tbl(["Ref", "Beneficiary", "Bank", "#Amount", "Requested", "Status", ""], list.map((p) => html`<tr><td class="mono">${p.reference}</td><td>${p.organiser_name}${p.vendor_name ? html`<div class="small">vendor: ${p.vendor_name}</div>` : ""}</td>
      <td class="small">${p.bank_name || "–"} ${p.bank_account_last4 ? `••${p.bank_account_last4}` : ""}<div class="tiny muted">${p.bank_account_holder || ""} ${p.bank_branch_code || ""}</div></td><td class="num">${moneyExact(p.amount_cents)}</td>
      <td class="small">${fmtDate(p.created_at)}<div class="tiny muted">${p.requested_by_name}${p.approved_by_name ? ` · approved ${p.approved_by_name}` : ""}</div></td><td>${badge(p.status)}${p.peach_status ? html`<div class="tiny">Peach: ${p.peach_status}</div>` : ""}${p.peach_failure_reason ? html`<div class="tiny muted">${p.peach_failure_reason}</div>` : ""}${p.bank_reference ? html`<div class="tiny mono">${p.bank_reference}</div>` : ""}</td>
      <td>${isF() ? html`<div class="row">${p.status === "requested" && !p.mine ? html`<button class="btn btn-good btn-sm" data-ok="${p.id}">Approve</button><button class="btn btn-ghost btn-sm" data-no="${p.id}">Reject</button>` : ""}
        ${p.status === "approved" ? html`<button class="btn btn-ghost btn-sm" data-reveal="${p.id}">Show account no.</button>${peachActive ? (['submitting','pending','processing'].includes(p.peach_status) ? html`<button class="btn btn-dark btn-sm" data-peach-check="${p.id}">Re-check Peach ${peach.environment === "sandbox" ? "sandbox" : ""}</button>` : html`<button class="btn btn-dark btn-sm" data-peach-send="${p.id}">${peach.environment === "sandbox" ? "Test with Peach sandbox" : "Send with Peach"}</button>`) : ""}${!peachActive ? html`<button class="btn btn-ghost btn-sm" data-paid="${p.id}">Record EFT</button>` : ""}` : ""}</div>` : ""}</td></tr>`))}`);
  $$("[data-ok]").forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/payouts/${b.dataset.ok}/decide`, { approve: true }))) payouts(); }));
  $$("[data-no]").forEach((b) => b.addEventListener("click", async () => { const why = await reason("Reject payout", "Tell the organiser why."); if (why && await act(() => post(`/api/admin/payouts/${b.dataset.no}/decide`, { approve: false, note: why }))) payouts(); }));
  $$("[data-reveal]").forEach((b) => b.addEventListener("click", async () => { try { const r = await post(`/api/admin/payouts/${b.dataset.reveal}/reveal-account`); dialog("Account number", html`<p class="mono">${r.accountNumber}</p><p class="tiny muted">This view was recorded in the audit log.</p>`); } catch (err) { toast(err.message, "bad"); } }));
  $$("[data-paid]").forEach((b) => b.addEventListener("click", async () => { const ref = await confirmDialog("Record EFT", "Only after the transfer has actually been made.", { confirm: "Record as paid", input: { label: "Bank transfer reference", required: true } }); if (ref && await act(() => post(`/api/admin/payouts/${b.dataset.paid}/mark-paid`, { bankReference: ref }))) payouts(); }));
  $$('[data-peach-send]').forEach((b) => b.addEventListener("click", async () => {
    const sandbox = peach.environment === "sandbox";
    const confirm = await confirmDialog(sandbox ? "Send Peach sandbox test?" : "Send this Peach payout?", sandbox ? "This is a sandbox test only. It cannot move money, mark the real payout paid, or reduce an organiser’s balance." : "Peach will transfer this amount to the organiser’s saved bank account. Peach payouts cannot be recalled, and rejected transfers may incur fees. Confirm the approved amount and beneficiary, and check Peach has sufficient float.", { confirm: sandbox ? "Send sandbox test" : "Send payout", danger: !sandbox });
    if (confirm && await act(() => post(`/api/admin/payouts/${b.dataset.peachSend}/send-peach`, { confirm: true }))) payouts();
  }));
  $$('[data-peach-check]').forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/payouts/${b.dataset.peachCheck}/peach-recheck`, {}))) payouts(); }));
}

async function payments() {
  const [{ payments: list, stale = [] }, { webhooks }] = await Promise.all([get("/api/admin/payments"), get("/api/admin/webhooks")]);
  render(main, html`${head("Payments & webhooks", "A payment is confirmed only by a verified provider webhook or a direct status check, never by the buyer's browser.")}
    ${stale.length ? html`<section class="card mb"><h2>Waiting for the provider</h2><p class="muted small">Pending for more than 30 minutes.</p>${tbl(["Since", "Order", "Provider", "#Amount", "What to do"], stale.map((p) => html`<tr><td class="small">${fmtDateTime(p.created_at)}</td><td class="mono small">${p.order_reference || "–"}</td><td>${p.provider}${p.environment !== "live" ? html` <span class="badge amber">TEST</span>` : ""}</td><td class="num">${moneyExact(p.amount_cents)}</td><td class="small">${p.what_to_do}</td></tr>`))}</section>` : ""}
    <h2>Payments</h2>${tbl(["When", "Purpose", "User", "Provider ref", "#Amount", "Status", ""], list.map((p) => html`<tr><td class="small">${fmtDateTime(p.created_at)}</td><td>${p.purpose}</td><td class="small">${p.email}</td><td class="mono small">${p.provider_reference || "–"}</td><td class="num">${moneyExact(p.amount_cents)}${p.refunded_cents ? html`<div class="tiny">−${moneyExact(p.refunded_cents)}</div>` : ""}</td><td>${badge(p.status)}${p.failure_reason ? html`<div class="tiny muted">${p.failure_reason}</div>` : ""}</td>
      <td>${["pending", "cancelled", "failed"].includes(p.status) && p.provider_reference ? html`<button class="btn btn-ghost btn-sm" data-re="${p.id}">Re-check</button>` : ""}</td></tr>`))}
    <h2 class="mt-lg">Webhook deliveries</h2>${tbl(["Received", "Event id", "Signature", "Attempts", "Status", "Error"], webhooks.map((w) => html`<tr><td class="small">${fmtDateTime(w.received_at)}</td><td class="mono small">${w.provider_event_id}</td><td>${w.signature_valid ? "valid" : html`<span class="badge bad">Invalid</span>`}</td><td>${w.attempts}</td><td>${badge(w.status)}</td><td class="small">${w.error || ""}</td></tr>`))}`);
  $$("[data-re]").forEach((b) => b.addEventListener("click", async () => { try { const r = await post(`/api/admin/payments/${b.dataset.re}/recheck`); toast(`Provider says: ${r.result}`, "good"); payments(); } catch (err) { toast(err.message, "bad"); } }));
}

// Money problems the ledger check found (paid twice, over-refunded, money an
// organiser owes, desk money not netted, refunds made in the provider's portal).
const FINDING = { paid_twice: "Paid twice", over_refunded: "Over-refunded", organiser_negative: "Organiser owes", desk_not_netted: "Desk money not netted", provider_refund: "Refund outside TicketRoom" };
function moneyFindings(list = []) {
  if (!list.length) return "";
  return html`<h3 class="mt">Needs a look</h3>${tbl(["What", "Reference", "#Amount", "Detail"], list.map((x) => html`<tr><td><span class="badge ${x.severity === "error" ? "bad" : "amber"}">${FINDING[x.kind] || x.kind}</span></td><td class="mono small">${x.reference}</td><td class="num">${x.cents ? moneyExact(x.cents) : "–"}</td><td class="small">${x.text}</td></tr>`))}`;
}

async function reconciliation() {
  const { runs, ledger, providers = [] } = await get("/api/admin/reconciliation");
  const today = new Date(); const from = new Date(today.getTime() - 7 * 864e5);
  render(main, html`${head("Reconciliation", "Compare TicketRoom's records with the provider's report. Every difference needs a note before it is resolved. Nothing is corrected automatically.")}
    ${isF() ? html`<section class="card"><h2>New run</h2><form class="stack" id="rf"><div class="grid-3"><div class="field"><label for="rp">Provider</label><select id="rp" name="provider" ${raw(providers.length ? "" : "disabled")}>${providers.length ? providers.map((x) => html`<option value="${x}">${x === "yoco" ? "Yoco" : x === "payfast" ? "PayFast" : x}</option>`) : html`<option value="">No payment provider set up yet</option>`}</select></div>
      <div class="field"><label for="rfr">From</label><input id="rfr" name="from" type="date" value="${from.toISOString().slice(0, 10)}"></div><div class="field"><label for="rto">To (exclusive)</label><input id="rto" name="to" type="date" value="${new Date(today.getTime() + 864e5).toISOString().slice(0, 10)}"></div></div>
      <div class="field"><label for="rc">Provider report (CSV) <span class="muted">${providers.length ? "(export it from the provider's portal)" : "(optional, otherwise fetched from the provider)"}</span></label><textarea id="rc" name="csv" placeholder="reference,amount_cents,status,refunded_cents,fee_cents"></textarea></div><button class="btn btn-dark">Run reconciliation</button></form></section>` : ""}
    <section class="card mt"><h2>Ledger</h2><p class="${ledger.balanced ? "callout good" : "callout bad"} mb-0">${ledger.balanced ? "Every journal balances." : "Unbalanced journals found."} ${ledger.clearing.map((c) => `${accountName(c.account)}: ledger ${moneyExact(c.ledgerCents)} vs expected ${moneyExact(c.expectedCents)}`).join(" · ")}</p>${moneyFindings(ledger.exceptions)}</section>
    <h2 class="mt-lg">Runs</h2>${tbl(["When", "Period", "Source", "Matched", "Exceptions", "#Provider total", "#Internal total", ""], runs.map((r) => html`<tr><td class="small">${fmtDateTime(r.created_at)}<div class="tiny muted">${r.created_by_name || ""}</div></td><td class="small">${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}</td><td>${r.source}</td><td>${r.summary.matched || 0}</td><td>${r.summary.exceptions ? html`<span class="badge bad">${r.summary.exceptions}</span>` : "0"}</td><td class="num">${moneyExact(r.summary.providerTotalCents)}</td><td class="num">${moneyExact(r.summary.internalTotalCents)}</td><td><button class="btn btn-ghost btn-sm" data-run="${r.id}">Open</button></td></tr>`))}`);
  if ($("#rf")) onSubmit($("#rf"), async (v) => { await post("/api/admin/reconciliation", { provider: v.provider, from: new Date(v.from).toISOString(), to: new Date(v.to).toISOString(), csv: v.csv }); toast("Reconciliation complete.", "good"); reconciliation(); });
  $$("[data-run]").forEach((b) => b.addEventListener("click", async () => {
    const { items } = await get(`/api/admin/reconciliation/${b.dataset.run}`);
    const dlg = dialog("Reconciliation items", tbl(["Provider ref", "Outcome", "#Provider", "#Internal", "Status (prov / ours)", ""], items.map((i) => html`<tr><td class="mono small">${i.provider_reference}</td><td>${badge(i.outcome)}</td><td class="num">${i.provider_amount_cents != null ? moneyExact(i.provider_amount_cents) : "–"}</td><td class="num">${i.internal_amount_cents != null ? moneyExact(i.internal_amount_cents) : "–"}</td><td class="small">${i.provider_status || "–"} / ${i.internal_status || "–"}</td>
      <td>${i.resolved ? html`<span class="tiny muted">${i.resolution_note || "ok"}</span>` : isF() ? html`<button class="btn btn-ghost btn-sm" data-res="${i.id}">Resolve</button>` : ""}</td></tr>`)), { wide: true });
    $$("[data-res]", dlg).forEach((x) => x.addEventListener("click", async () => { const note = await reason("Resolve exception", "Explain what you checked and why this is resolved.", "Resolution note"); if (note && await act(() => post(`/api/admin/reconciliation/items/${x.dataset.res}/resolve`, { note }))) { x.replaceWith("resolved"); } }));
  }));
}

// Ledger account codes ("payable:retail:<id>") and keys ("vendorId") as words.
const ACCOUNT_WORDS = { wallets: "Wallets", wallet: "Wallet", resale: "Resale", sellers: "sellers", payable: "Owed to", retail: "retail partner", revenue: "Revenue", bank: "Bank", provider: "Payment provider", vendor: "Vendor", organiser: "Organiser", event: "event",
  booking_fees: "booking fees", service_fees: "service fees", commission: "commission", promotions: "promotions", payouts: "payouts", retail_payouts: "retail partner payouts", clearing: "clearing", user: "customer" };
const sentence = (t) => { const s = String(t || "").replace(/_/g, " ").trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const accountName = (code) => sentence(String(code || "").split(":").filter((p) => !/^[0-9a-f-]{16,}$/i.test(p)).map((p) => ACCOUNT_WORDS[p] || p.replace(/_/g, " ")).join(" "));
const humanKey = (k) => sentence(String(k).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase());
const detailValue = (v) => v === null || v === undefined ? "none" : typeof v === "boolean" ? (v ? "yes" : "no") : Array.isArray(v) ? v.map(detailValue).join(", ") : typeof v === "object" ? Object.entries(v).map(([k, x]) => `${humanKey(k).toLowerCase()} ${detailValue(x)}`).join(", ") : /^[a-z_]+(?::[a-z_]+)+$/.test(String(v)) ? String(v).replace(/[_:]/g, " ") : String(v).replace(/_/g, " ");
const detailsText = (d) => (d && typeof d === "object" ? Object.entries(d).map(([k, v]) => `${humanKey(k)}: ${detailValue(v)}`).join(" · ") : d ? String(d) : "");

async function ledgerPage() {
  const [{ accounts }, { journals }] = await Promise.all([get("/api/admin/ledger/accounts"), get("/api/admin/ledger/journals")]);
  render(main, html`${head("Ledger", "Immutable double-entry ledger. Debits positive, credits negative; every journal sums to zero. Corrections are reversal journals.")}
    <h2>Accounts</h2>${tbl(["Account", "Kind", "#Balance", "#Entries"], accounts.map((a) => html`<tr><td class="small" title="${a.code}">${accountName(a.code)}</td><td>${sentence(a.kind)}</td><td class="num">${moneyExact(a.balance_cents)}</td><td class="num">${a.entries}</td></tr>`))}
    <h2 class="mt-lg">Recent journals</h2>${tbl(["When", "Kind", "Reference", "Lines"], journals.map((j) => html`<tr><td class="small">${fmtDateTime(j.created_at)}</td><td>${sentence(j.kind)}${j.reverses_journal_id ? html`<div class="tiny muted">Reversal</div>` : ""}</td><td class="mono small">${j.reference}</td><td class="small mono">${j.lines.map((l) => html`<div>${l.amount > 0 ? "DR" : "CR"} ${moneyExact(Math.abs(l.amount))} <span title="${l.account}">${accountName(l.account)}</span></div>`)}</td></tr>`))}`);
}

async function tags() {
  const draw = async (q = "") => {
    const { tags: list } = await get(`/api/admin/tags?q=${encodeURIComponent(q)}`);
    render($("#tl"), tbl(["Tag", "Type", "Security", "Event", "Owner", "Status", ""], list.map((t) => html`<tr><td class="mono">${t.display_code}</td><td>${t.tag_type.replace("_", " ")}</td><td>${t.security_level === "uid_only" ? html`<span class="badge warn">UID only</span>` : t.security_level.replace("_", " ")}</td><td class="small">${t.event_title || "–"}</td><td class="small">${t.owner_email || ""}</td><td>${badge(t.status)}${t.status_reason ? html`<div class="tiny muted">${t.status_reason}</div>` : ""}</td>
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

// Guests' cash-outs by EFT. Finance approves (two people above the limit),
// sees the account number once (logged), pays it and records the reference.
async function cashouts(box) {
  const { cashouts: list, dualApprovalCents } = await get("/api/admin/cashouts");
  const eft = list.filter((c) => c.method === "eft");
  render(box, html`<h2 class="mt-lg">Wallet cash-outs by EFT</h2><p class="small muted">Guests asking for what was left on their cashless balance. Cash-outs of ${moneyExact(dualApprovalCents)} or more need two people in finance.</p>
    ${tbl(["Ref", "Guest", "Event", "Bank", "#Amount", "Status", ""], eft.map((c) => html`<tr><td class="mono">${c.reference}${c.test ? html` <span class="badge warn">Test</span>` : ""}</td><td>${c.guest_name}<div class="tiny muted">${c.guest_email}</div></td><td class="small">${c.event_title}</td>
      <td class="small">${c.bank_name} ••••${c.bank_account_last4}<div class="tiny muted">${c.bank_account_holder}</div></td><td class="num">${moneyExact(c.amount_cents)}${c.fee_cents ? html`<div class="tiny muted">fee ${moneyExact(c.fee_cents)}</div>` : ""}</td>
      <td>${badge(c.status === "approved_once" ? "needs second approval" : c.status)}${c.first_approved_by_name ? html`<div class="tiny muted">first: ${c.first_approved_by_name}</div>` : ""}</td>
      <td>${isF() && ["requested", "approved_once"].includes(c.status) ? html`<div class="row"><button class="btn btn-good btn-sm" data-coa="${c.id}">Approve</button><button class="btn btn-ghost btn-sm" data-cor="${c.id}">Reject</button></div>` : ""}
        ${isF() && c.status === "approved" ? html`<div class="row"><button class="btn btn-ghost btn-sm" data-cov="${c.id}">Show account no.</button><button class="btn btn-dark btn-sm" data-cop="${c.id}">Mark paid</button></div>` : ""}</td></tr>`), "No EFT cash-outs.")}`);
  $$("[data-coa]", box).forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/cashouts/${b.dataset.coa}/decide`, { approve: true }), "Approved.")) cashouts(box); }));
  $$("[data-cor]", box).forEach((b) => b.addEventListener("click", async () => { const why = await reason("Reject cash-out", "The guest is emailed this reason and the money goes back on their balance."); if (why && await act(() => post(`/api/admin/cashouts/${b.dataset.cor}/decide`, { approve: false, note: why }))) cashouts(box); }));
  $$("[data-cov]", box).forEach((b) => b.addEventListener("click", async () => { try { const r = await post(`/api/admin/cashouts/${b.dataset.cov}/reveal-account`); dialog("Account number", html`<p class="mono">${r.accountNumber}</p><p class="small muted">This view is in the audit log.</p>`); } catch (err) { toast(err.message, "bad"); } }));
  $$("[data-cop]", box).forEach((b) => b.addEventListener("click", async () => { const ref = await reason("Record the EFT", "Make the EFT from TicketRoom's bank first, then enter its reference.", "Bank reference"); if (ref && await act(() => post(`/api/admin/cashouts/${b.dataset.cop}/mark-paid`, { bankReference: ref }), "Cash-out marked as paid.")) cashouts(box); }));
}

// TicketRoom Exchange: sellers of resold tickets are paid back to their card
// (automatic, or by hand for PayFast) or by EFT (finance approves and pays).
async function resalePayouts(box) {
  const { payouts: list } = await get("/api/admin/resale-payouts");
  const open = list.filter((p) => p.status !== "paid");
  render(box, html`<h2 class="mt-lg">Resale payouts</h2><p class="small muted">Fans who sold a ticket on TicketRoom Exchange. Card payouts go back to the card they paid with; EFT payouts need approval, then the EFT.</p>
    ${tbl(["Ref", "Seller", "Event", "How", "#Amount", "Status", ""], [...open, ...list.filter((p) => p.status === "paid").slice(0, 20)].map((p) => html`<tr><td class="mono">${p.reference}${p.test ? html` <span class="badge warn">Test</span>` : ""}<div class="tiny muted">${p.listing_reference}</div></td>
      <td>${p.seller_name}<div class="tiny muted">${p.seller_email}</div></td><td class="small">${p.event_title}</td>
      <td class="small">${p.method === "card" ? `Card (${p.provider})` : p.bank_account_last4 ? html`EFT ${p.bank_name} ••••${p.bank_account_last4}<div class="tiny muted">${p.bank_account_holder}</div>` : "EFT, no account yet"}${p.failure_reason ? html`<div class="tiny">${p.failure_reason}</div>` : ""}</td>
      <td class="num">${moneyExact(p.amount_cents)}</td><td>${badge(p.status)}</td>
      <td>${isF() && p.status === "requested" ? html`<button class="btn btn-good btn-sm" data-rpa="${p.id}">Approve</button>` : ""}
        ${isF() && p.status === "approved" ? html`<div class="row"><button class="btn btn-ghost btn-sm" data-rpv="${p.id}">Show account no.</button><button class="btn btn-dark btn-sm" data-rpp="${p.id}">Mark paid</button></div>` : ""}
        ${isF() && p.status === "manual_pending" ? html`<button class="btn btn-dark btn-sm" data-rpp="${p.id}">Mark refunded</button>` : ""}${isF() && p.status === "failed" ? html`<button class="btn btn-ghost btn-sm" data-rpr="${p.id}">Retry</button>` : ""}</td></tr>`), "No resale payouts.")}`);
  $$("[data-rpa]", box).forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/resale-payouts/${b.dataset.rpa}/approve`), "Approved.")) resalePayouts(box); }));
  $$("[data-rpv]", box).forEach((b) => b.addEventListener("click", async () => { try { const r = await post(`/api/admin/resale-payouts/${b.dataset.rpv}/reveal-account`); dialog("Account number", html`<p class="mono">${r.accountNumber}</p><p class="small muted">This view is in the audit log.</p>`); } catch (err) { toast(err.message, "bad"); } }));
  $$("[data-rpp]", box).forEach((b) => b.addEventListener("click", async () => { const ref = await reason("Record the payment", "Make the EFT, or the refund in the provider dashboard, first. Then enter its reference.", "Reference"); if (ref && await act(() => post(`/api/admin/resale-payouts/${b.dataset.rpp}/mark-paid`, { reference: ref }), "Payout marked as paid.")) resalePayouts(box); }));
  $$("[data-rpr]", box).forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/resale-payouts/${b.dataset.rpr}/retry`), "Retried.")) resalePayouts(box); }));
}

// Wristbands & wallets: run a top-up or cash-out desk for any cashless event,
// and see what came in and went out at each one.
async function wallets() {
  const fin = await get("/api/admin/cashless");
  render(main, html`${head("Wristbands & wallets", "Top up a guest's wristband with cash or a card machine, pay out balances in cash, and see each event's cashless money.")}
    ${tbl(["Event", "#Online top-ups", "#Desk cash", "#Desk card", "#Cashed out", "#Still on wallets"], fin.events.map((e) => html`<tr><td>${e.title}<div class="tiny muted">${e.organiser_name}</div></td><td class="num">${moneyExact(e.topups_cents)}</td>
      <td class="num">${moneyExact(e.desk_cash_cents)}</td><td class="num">${moneyExact(e.desk_card_cents)}</td><td class="num">${moneyExact(e.cashed_out_cash_cents + e.cashed_out_eft_cents + e.refunded_cents)}</td><td class="num">${moneyExact(e.outstanding_cents)}</td></tr>`), "No cashless events yet.")}
    <section class="mt-lg"><h2>Vendor commissions</h2><p class="small muted">Admin-set rate for each vendor agreement. Rate changes affect future sales only; recorded sales and settlements stay unchanged.</p>
      ${tbl(["Vendor", "Event", "Organiser", "Rate", "Sales", "Commission earned", ""], fin.vendors.map((v) => html`<tr><td>${v.name}<div class="tiny muted">${badge(v.status)}</div></td><td class="small">${v.event_title}</td><td class="small">${v.organiser_name}</td><td>${(v.commission_bps / 100).toFixed(2)}%</td><td class="num">${v.sales.toLocaleString("en-ZA")}</td><td class="num">${moneyExact(v.commission_cents)}</td><td>${isA() ? html`<button class="btn btn-ghost btn-sm" data-vfee="${v.id}" data-name="${v.name}" data-rate="${v.commission_bps}">Set rate</button>` : "Admin only"}</td></tr>`), "No vendors yet.")}</section>
    <div id="desk" class="mt-lg"></div>`);
  deskPicker($("#desk"), { title: "Run a desk", intro: "Choose the event. Every top-up is logged under your name." });
  $$('[data-vfee]').forEach((b) => b.addEventListener("click", async () => {
    const entered = await confirmDialog(`Vendor commission · ${b.dataset.name}`, "The new rate applies to future vendor sales only. Past sales and settlements are unchanged.", { confirm: "Save rate", input: { label: "Commission (%)", type: "number", placeholder: (Number(b.dataset.rate) / 100).toFixed(2), required: true } });
    if (entered === false) return;
    const rate = Number(entered);
    if (!Number.isFinite(rate) || rate < 0 || rate > 50) return toast("Enter a commission from 0% to 50%.", "bad");
    if (await act(() => patch(`/api/admin/cashless/vendors/${b.dataset.vfee}/commission`, { commissionBps: Math.round(rate * 100) }), "Vendor commission updated.")) wallets();
  }));
}

async function terminals() {
  const { terminals: list } = await get("/api/admin/terminals");
  render(main, html`${head("Terminals")}${tbl(["Terminal", "Vendor", "Event", "Last seen", "Status", ""], list.map((t) => html`<tr><td>${t.label}</td><td>${t.vendor_name}</td><td class="small">${t.event_title}</td><td class="small">${t.last_seen_at ? fmtDateTime(t.last_seen_at) : "never"}</td><td>${badge(t.status)}</td>
    <td>${isA() && t.status !== "retired" ? html`<button class="btn btn-ghost btn-sm" data-t="${t.id}" data-s="${t.status === "active" ? "suspended" : "active"}">${t.status === "active" ? "Suspend" : "Activate"}</button>` : ""}</td></tr>`))}`);
  $$("[data-t]").forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/terminals/${b.dataset.t}/status`, { status: b.dataset.s }))) terminals(); }));
}

// Support: every question is a conversation. Customer care replies (by
// email), or passes it to the organiser it belongs to, who replies from their
// portal. "With organiser" shows who has it.
async function support() {
  const { cases } = await get("/api/admin/support");
  const open = cases.filter((c) => ["open", "in_progress"].includes(c.status));
  render(main, html`${head("Support & callbacks", `${open.length} open · ${open.filter((c) => c.overdue).length} overdue · ${open.filter((c) => c.handled_by === "organiser").length} with organisers. Callback requests promise a response within 24 to 48 hours.`)}
    ${tbl(["Ref", "Customer", "Topic", "Request", "Due", "Status", ""], cases.map((c) => html`<tr><td class="mono">${c.reference}<div class="tiny muted">${c.source === "account_deletion" ? "deletion request" : c.source || "web"}</div></td>
      <td class="small">${c.full_name ? html`<strong>${c.full_name}</strong><br>` : ""}${c.phone ? html`<a href="tel:${c.phone}">${c.phone}</a><br>` : ""}<a href="mailto:${c.email}">${c.email}</a>${c.preferred_time ? html`<div class="tiny muted">best time: ${c.preferred_time}</div>` : ""}</td>
      <td>${c.category}</td><td><strong>${c.subject}</strong><div class="small muted">${c.body.slice(0, 160)}</div></td>
      <td class="small">${c.due_at ? html`${fmtDateTime(c.due_at)}${c.overdue ? html`<div><span class="badge bad">Overdue</span></div>` : ""}` : "–"}</td>
      <td>${badge(c.status)}${c.handled_by === "organiser" ? html`<div class="tiny"><span class="badge amber plain">With ${c.organiser_name}</span></div>` : ""}${c.assignee ? html`<div class="tiny muted">${c.assignee}</div>` : ""}</td>
      <td><button class="btn btn-ghost btn-sm" data-c="${c.id}">Open</button></td></tr>`))}`);
  $$("[data-c]").forEach((b) => b.addEventListener("click", () => supportCase(b.dataset.c)));
}
async function supportCase(id) {
  const { case: c, messages, suggestions } = await get(`/api/admin/support/${id}`);
  const who = { customer: "Customer", ticketroom: "TicketRoom", organiser: "Organiser", system: "Note" };
  const can = isA() || isS();
  const dlg = dialog(`${c.subject} · ${c.reference}`, html`<div class="stack">
    <div class="thread"><div class="msg-row customer"><div class="tiny muted">${c.full_name || c.email} · ${fmtDateTime(c.created_at)}</div><p class="prose mb-0">${c.body}</p></div>
      ${messages.map((m) => html`<div class="msg-row ${m.author_kind}"><div class="tiny muted">${who[m.author_kind]}${m.author_name ? ` · ${m.author_name}` : ""} · ${fmtDateTime(m.created_at)}${m.emailed ? " · emailed" : ""}</div><p class="prose mb-0">${m.body}</p></div>`)}</div>
    ${c.handled_by === "organiser" ? html`<p class="callout small mb-0">With <strong>${c.organiser_name}</strong>${c.event_title ? ` (${c.event_title})` : ""} since ${fmtDateTime(c.transferred_at)}. They reply from their portal. ${can ? html`<button class="btn-link" data-back>Take it back</button>` : ""}</p>` : ""}
    ${can ? html`<form class="stack card flat" data-reply><div class="field"><label for="sr-msg">Reply to the customer</label><textarea id="sr-msg" name="message" required minlength="2" placeholder="Write as you'd speak to them. It's emailed from hello@ticketroom.co.za."></textarea></div>
      <label class="check"><input type="checkbox" name="resolve"><span>This answers it: mark resolved</span></label><button class="btn btn-dark">Send reply</button></form>
      ${c.handled_by !== "organiser" ? html`<form class="stack card flat" data-transfer><strong>Pass to the organiser</strong>
        ${suggestions.length ? html`<div class="field"><label for="sr-pick">Events this customer booked</label><select id="sr-pick" name="pick"><option value="">Choose…</option>${suggestions.map((x, i) => html`<option value="${i}">${x.event_title} · ${x.organiser_name} (${x.organiser_ref || ""})</option>`)}</select></div>` : ""}
        <div class="field"><label for="sr-org">Or find an organiser</label><input id="sr-org" list="sr-orgs" placeholder="Name or ORG-…" autocomplete="off"><datalist id="sr-orgs"></datalist></div>
        <div class="field"><label for="sr-note">Note for the organiser <span class="muted">(optional)</span></label><textarea id="sr-note" name="note" maxlength="1000"></textarea></div>
        <label class="check"><input type="checkbox" name="tellCustomer" checked><span>Tell the customer it's with the organiser</span></label>
        <button class="btn btn-primary">Send to organiser</button></form>` : ""}
      <form class="row" data-status><label class="sr-only" for="sr-st">Status</label><select id="sr-st" name="status">${["open", "in_progress", "resolved", "closed"].map((s) => html`<option ${raw(s === c.status ? "selected" : "")}>${s}</option>`)}</select><button class="btn btn-ghost btn-sm">Update status</button></form>` : ""}
  </div>`, { wide: true, onClose: support });
  if ($("[data-reply]", dlg)) onSubmit($("[data-reply]", dlg), async (v) => { await post(`/api/admin/support/${id}/reply`, { message: v.message, resolve: !!v.resolve }); toast("Reply emailed to the customer.", "good"); dlg.close(); });
  if ($("[data-status]", dlg)) onSubmit($("[data-status]", dlg), async (v) => { await post(`/api/admin/support/${id}`, { status: v.status }); toast("Status updated.", "good"); dlg.close(); });
  $("[data-back]", dlg)?.addEventListener("click", async () => { await post(`/api/admin/support/${id}/take-back`); toast("Taken back.", "good"); dlg.close(); });
  const tf = $("[data-transfer]", dlg);
  if (tf) {
    let chosen = null;
    const find = $("#sr-org", tf), list = $("#sr-orgs", tf);
    let found = [];
    find.addEventListener("input", async () => {
      chosen = null;
      const q = find.value.trim();
      found = q.length < 2 ? [] : (await get(`/api/admin/support-organisers?q=${encodeURIComponent(q)}`)).organisers;
      render(list, html`${found.map((o) => html`<option value="${o.name} (${o.ref || ""})"></option>`)}`);
      chosen = found.find((o) => `${o.name} (${o.ref || ""})` === q) || null;
    });
    find.addEventListener("change", () => { chosen = found.find((o) => `${o.name} (${o.ref || ""})` === find.value) || null; });
    onSubmit(tf, async (v) => {
      const s2 = v.pick !== undefined && v.pick !== "" ? suggestions[Number(v.pick)] : null;
      const organiserId = s2?.organiser_id || chosen?.id;
      if (!organiserId) throw Object.assign(new Error("Choose the event, or find the organiser by name or ID."), { details: {} });
      await post(`/api/admin/support/${id}/transfer`, { organiserId, eventId: s2?.event_id, note: v.note || undefined, tellCustomer: !!v.tellCustomer });
      toast("Passed to the organiser. They've been emailed.", "good"); dlg.close();
    });
  }
}

async function audit() {
  const { entries } = await get("/api/admin/audit");
  render(main, html`${head("Audit log", "Append-only and hash-chained. The database refuses edits and deletions; the chain check detects tampering done around it.", html`<button class="btn btn-dark" data-verify>Verify chain</button>`)}
    ${tbl(["When", "Actor", "Action", "Entity", "Details"], entries.map((e) => html`<tr><td class="small">${fmtDateTime(e.occurred_at)}</td><td class="small">${e.actor_name || e.actor_role}</td><td title="${e.action}">${sentence(String(e.action || "").replace(/\./g, " "))}</td><td class="small">${sentence(e.entity_type || "")} <span class="mono">${e.entity_id ? e.entity_id.slice(0, 8) : ""}</span></td><td class="tiny">${detailsText(e.details).slice(0, 200)}</td></tr>`))}`);
  $("[data-verify]").addEventListener("click", async () => { const r = await get("/api/admin/audit/verify"); toast(r.ok ? `Chain intact (${r.checked} entries).` : `Chain BROKEN at entry ${r.brokenAt}.`, r.ok ? "good" : "bad"); });
}

async function outbox() {
  const { messages, adapters, failed = 0, paused } = await get("/api/admin/outbox");
  const canRetry = (isA() || isS()) && failed > 0;
  render(main, html`${head("Messages", `Email adapter: ${adapters.email} · SMS adapter: ${adapters.sms}. A message that can't go out yet is tried again later, waiting longer each time, for about a day.`,
      canRetry ? html`<button class="btn btn-dark" data-retry>Retry failed (${failed})</button>` : "")}
    ${paused ? html`<p class="callout warn">Email is paused for a few minutes because the mail server is busy or can't be reached. It carries on by itself.</p>` : ""}
    ${tbl(["When", "Channel", "Kind", "To", "Subject", "Status"], messages.map((m) => html`<tr><td class="small">${fmtDateTime(m.created_at)}</td><td>${m.channel}</td><td>${m.kind}</td><td class="small">${m.to_address}</td><td class="small">${m.subject || ""}</td><td>${badge(m.status)}${m.status === "queued" && m.next_attempt_at ? html`<div class="tiny muted">Next try ${fmtDateTime(m.next_attempt_at)}</div>` : ""}${m.last_error ? html`<div class="tiny muted">${m.last_error}</div>` : ""}</td></tr>`))}`);
  $("[data-retry]")?.addEventListener("click", async () => {
    if (!(await confirmDialog(`Retry ${failed} failed message${failed === 1 ? "" : "s"}?`, "They go back in the queue and are tried again for about a day.", { confirm: "Retry" }))) return;
    try { const r = await post("/api/admin/outbox/retry", {}); toast(`${r.retried} message${r.retried === 1 ? " is" : "s are"} back in the queue.`, "good"); outbox(); }
    catch (err) { toast(err.message, "bad"); }
  });
}

// Copies of the database, made every day, before every update and on request.
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const BACKUP_KIND = { daily: "Daily", manual: "Made by hand", "before-upgrade": "Before an update" };
async function backups() {
  if (!isA()) { render(main, html`${head("Backups", "Only admins can make and download backups.")}`); return; }
  const d = await get("/api/admin/backups");
  render(main, html`${head("Backups", `A copy of the whole database is made every day, before every update and when you press Back up now. The newest ${d.keep} are kept (and ${d.keepBeforeUpgrade} made before updates) in ticketroom-data/backups, outside the website. Download one now and then and keep it somewhere safe: a copy on the same server does not help if the server is lost.`,
      html`<button class="btn btn-primary" data-backup-now>Back up now</button>`)}
    ${d.problems.length ? html`<div class="callout warn stack">${d.problems.map((p) => html`<p class="mb-0">${p}</p>`)}</div>` : ""}
    <p class="small muted">Background jobs: ${d.jobs.fresh ? "running on time" : `late (${d.jobs.stale.join(", ")})`}. Cron job: ${d.jobs.cron.lastRunAt ? `last ran ${fmtDateTime(d.jobs.cron.lastRunAt)}` : "not set up yet"}.</p>
    ${tbl(["Made", "Kind", "#Size", ""], d.backups.map((b) => html`<tr data-backup-row><td class="small">${fmtDateTime(b.createdAt)}</td><td>${BACKUP_KIND[b.reason] || b.reason}</td><td class="num">${fmtSize(b.sizeBytes)}</td>
      <td><a class="btn btn-ghost btn-sm" href="/api/admin/backups/${encodeURIComponent(b.id)}" download>Download</a></td></tr>`), "No backups yet. Press Back up now to make the first one.")}
    <section class="card mt stack"><h2>Restoring a backup</h2><p class="mb-0">Restoring replaces everything on the site with the copy, so it is done on the server, with maintenance on. DEPLOY-AFRIHOST.md, "Restoring a backup", has the steps. Downloads are recorded in the audit log.</p></section>`);
  $("[data-backup-now]").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try { await post("/api/admin/backups", {}); toast("Backup made.", "good"); }
    catch (err) { toast(err.message, "bad"); }
    backups();
  });
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
    <section class="card stack ${s.maintenance.enabled ? "flat" : ""}" aria-labelledby="mt-h"><h2 id="mt-h">Maintenance mode ${s.maintenance.enabled ? html`<span class="badge bad">ON</span>` : html`<span class="badge good">Off</span>`}</h2>
      <p class="small muted mb-0">When on, every visitor gets the maintenance page from the server: nobody can browse, book, sign up or sign in except TicketRoom staff, who see the site as normal with a yellow reminder bar. Payment notifications from Yoco and PayFast keep arriving.</p>
      <form class="stack" id="f-mt"><div class="field"><label for="mt-msg">Message shown to visitors</label><textarea id="mt-msg" name="message" maxlength="500" ${ro}>${s.maintenance.message}</textarea></div>
        <div class="row">${s.maintenance.enabled ? html`<button class="btn btn-good" name="enabled" value="0" ${ro}>Turn maintenance OFF</button>` : html`<button class="btn btn-danger" name="enabled" value="1" ${ro}>Turn maintenance ON</button>`}<button type="button" class="btn btn-ghost" data-save-mt ${ro}>Save message only</button><button type="button" class="btn btn-ghost" data-preview-mt>See what visitors see</button></div></form></section>

    <section class="card stack" aria-labelledby="bn-h"><h2 id="bn-h">Announcement banner ${s.banner.enabled ? html`<span class="badge good">Showing</span>` : html`<span class="badge">Hidden</span>`}</h2>
      <p class="small muted mb-0">Shown at the top of every public page. Visitors can hide it for their visit; turn it off here to remove it for everyone.</p>
      <form class="stack" id="f-bn"><label class="check"><input type="checkbox" name="enabled" ${raw(s.banner.enabled ? "checked" : "")} ${ro}><span>Show the banner</span></label>
        <div class="field"><label for="bn-t">Text</label><input id="bn-t" name="text" maxlength="200" required value="${s.banner.text}" ${ro}></div>
        <div class="grid-2"><div class="field"><label for="bn-lt">Link text <span class="muted">(optional)</span></label><input id="bn-lt" name="linkText" maxlength="40" value="${s.banner.linkText || ""}" ${ro}></div>
        <div class="field"><label for="bn-lu">Link</label><input id="bn-lu" name="linkUrl" maxlength="200" value="${s.banner.linkUrl || ""}" placeholder="/sell" ${ro}></div></div>
        <button class="btn btn-dark" ${ro}>Save banner</button></form></section>
    </div>

    <section class="card stack mt" aria-labelledby="retail-h"><h2 id="retail-h">Retail partner programme ${s.retail.enabled ? html`<span class="badge good">Active</span>` : html`<span class="badge">Coming soon</span>`}</h2>
      <p class="small muted mb-0">When inactive, the public Retail page shows a Coming soon notice and retail applications, directory listings, attributed sales and retailer tills are paused. Admins can still review applications and reconcile existing earnings. Pausing is blocked until open retailer shifts are cashed up and reserved sales are resolved.</p>
      <form class="stack" id="f-retail"><label class="check"><input type="checkbox" name="enabled" ${raw(s.retail.enabled ? "checked" : "")} ${ro}><span>Activate retail applications and sales</span></label>
        <div class="field"><label for="retail-message">Coming soon message</label><textarea id="retail-message" name="message" maxlength="300" ${ro}>${s.retail.message}</textarea><span class="hint">Shown on the public Retail page while the programme is inactive.</span></div>
        <button class="btn btn-dark" ${ro}>Save retail settings</button></form></section>

    <section class="card stack mt" aria-labelledby="fees-h"><h2 id="fees-h">Pricing and fees</h2>
      <p class="small muted mb-0">Controls ticket fees, Promote and advertising prices, cashless vendor commission, and the approved retailer share. Default retailer share: 1.50% of ticket value plus R3.00 of the service fee per paid ticket. This comes from existing fees, never adds a buyer charge, applies only to paid retailer-attributed sales, and is capped at the fees actually collected. Free tickets earn nothing. Changes apply to new orders; existing orders keep their recorded amounts.</p>
      <form class="grid-2" id="f-fees"><div class="field"><label for="fee-service">Service fee per paid ticket (R)</label><input id="fee-service" name="service" inputmode="decimal" required value="${(s.fees.ticketFeeFixedCents / 100).toFixed(2)}"><span class="hint">Free tickets are never charged.</span></div>
        <div class="field"><label for="fee-service-rate">Service fee percentage (%)</label><input id="fee-service-rate" name="serviceRate" type="number" inputmode="decimal" min="0" max="20" step="0.01" required value="${(s.fees.ticketFeeBps / 100).toFixed(2)}"><span class="hint">Optional percentage added to the flat fee.</span></div>
        <div class="field"><label for="fee-commission">Standard commission (%)</label><input id="fee-commission" name="commission" type="number" inputmode="decimal" min="0" max="50" step="0.01" required value="${(s.fees.organiserCommissionBps / 100).toFixed(2)}"><span class="hint">Percentage of net ticket sales.</span></div>
        <div class="field"><label for="fee-commission-flat">Commission per paid ticket (R)</label><input id="fee-commission-flat" name="commissionFixed" inputmode="decimal" required value="${(s.fees.organiserCommissionFixedCents / 100).toFixed(2)}"><span class="hint">Added to the percentage commission. Organiser-specific percentage overrides still apply.</span></div>
        <div class="field"><label for="fee-promotion">Promote package per event (R)</label><input id="fee-promotion" name="promotionPrice" inputmode="decimal" required value="${(s.fees.promotionPriceCents / 100).toFixed(2)}"><span class="hint">One-off price, through the event end. New purchases only.</span></div>
        <div class="field"><label for="fee-advertising">Advertising poster, starting rate per day (R)</label><input id="fee-advertising" name="advertisingDailyPrice" inputmode="decimal" required value="${(s.fees.advertisingDailyPriceCents / 100).toFixed(2)}"><span class="hint">Displayed on the advertising page; dates and final quote are confirmed manually.</span></div>
        <div class="field"><label for="fee-cashless">Cashless vendor commission default (%)</label><input id="fee-cashless" name="cashlessCommission" type="number" inputmode="decimal" min="0" max="50" step="0.01" required value="${(s.fees.cashlessVendorCommissionBps / 100).toFixed(2)}"><span class="hint">Applied to new vendors. Set individual negotiated rates in Wristbands & wallets; existing agreements are unchanged.</span></div>
        <div class="field"><label for="fee-retail-commission">Retail partner share of ticket value (%)</label><input id="fee-retail-commission" name="retailCommissionShare" type="number" inputmode="decimal" min="0" max="50" step="0.01" required value="${(s.fees.retailCommissionShareBps / 100).toFixed(2)}"><span class="hint">Default 1.50% of net ticket value, taken from the organiser commission actually charged.</span></div>
        <div class="field"><label for="fee-retail-service">Retail partner service-fee share per paid ticket (R)</label><input id="fee-retail-service" name="retailServiceShare" inputmode="decimal" required value="${(s.fees.retailServiceFeeShareCents / 100).toFixed(2)}"><span class="hint">Default R3.00 of the service fee; the backend caps this at service-fee revenue actually collected.</span></div>
        <div><button class="btn btn-dark" ${ro}>Save fee rates</button></div></form></section>

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
  $("[data-preview-mt]").addEventListener("click", () => dialog("What visitors see", html`<div class="maint-preview"><img src="/assets/ticketroom-logo.png" alt="TicketRoom" width="260" height="130"><h2>We'll be right back</h2><p>${$("#mt-msg").value}</p><p class="small">Need help? Use our contact form; we'll email you a reference.</p></div>`));
  $("[data-save-mt]").addEventListener("click", () => save("maintenance", { enabled: s.maintenance.enabled, message: $("#mt-msg").value }, "Message saved."));
  $("#f-bn").addEventListener("submit", (e) => { e.preventDefault(); const v = fv(e.target); save("banner", { enabled: e.target.enabled.checked, text: v.text, linkText: v.linkText || undefined, linkUrl: v.linkUrl || undefined }, "Banner saved."); });
  $("#f-retail").addEventListener("submit", (e) => { e.preventDefault(); save("retail", { enabled: e.target.enabled.checked, message: e.target.message.value.trim() }, e.target.enabled.checked ? "Retail applications and sales are active." : "Retail programme paused; the public page now shows Coming soon."); });
  $("#f-fees").addEventListener("submit", (e) => {
    e.preventDefault();
    const service = parseRand(e.target.service.value);
    const serviceRate = Number(e.target.serviceRate.value);
    const commission = Number(e.target.commission.value);
    const commissionFixed = parseRand(e.target.commissionFixed.value);
    const promotionPrice = parseRand(e.target.promotionPrice.value);
    const advertisingDailyPrice = parseRand(e.target.advertisingDailyPrice.value);
    const cashlessCommission = Number(e.target.cashlessCommission.value);
    const retailCommissionShare = Number(e.target.retailCommissionShare.value);
    const retailServiceShare = parseRand(e.target.retailServiceShare.value);
    if (service === null || service > 10000) return toast("Enter a service fee from R0 to R100.00.", "bad");
    if (!Number.isFinite(serviceRate) || serviceRate < 0 || serviceRate > 20) return toast("Enter a service fee percentage from 0% to 20%.", "bad");
    if (!Number.isFinite(commission) || commission < 0 || commission > 50) return toast("Enter a commission from 0% to 50%.", "bad");
    if (commissionFixed === null || commissionFixed > 5000) return toast("Enter a commission per ticket from R0 to R50.00.", "bad");
    if (promotionPrice === null || promotionPrice > 10000000) return toast("Enter a Promote price from R0.01 to R100,000.00.", "bad");
    if (advertisingDailyPrice === null || advertisingDailyPrice > 10000000) return toast("Enter an advertising rate from R0 to R100,000.00.", "bad");
    if (!Number.isFinite(cashlessCommission) || cashlessCommission < 0 || cashlessCommission > 50) return toast("Enter a cashless vendor commission from 0% to 50%.", "bad");
    if (!Number.isFinite(retailCommissionShare) || retailCommissionShare < 0 || retailCommissionShare > 50) return toast("Enter a retailer share from 0% to 50%.", "bad");
    if (retailServiceShare === null || retailServiceShare > 10000) return toast("Enter a retailer service-fee share from R0 to R100.00.", "bad");
    save("fees", { ticketFeeFixedCents: service, ticketFeeBps: Math.round(serviceRate * 100), organiserCommissionBps: Math.round(commission * 100), organiserCommissionFixedCents: commissionFixed, promotionPriceCents: promotionPrice, advertisingDailyPriceCents: advertisingDailyPrice, cashlessVendorCommissionBps: Math.round(cashlessCommission * 100), retailCommissionShareBps: Math.round(retailCommissionShare * 100), retailServiceFeeShareCents: retailServiceShare }, "Fee rates saved. New orders, purchases and vendors will use these rates.");
  });
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
  render(main, html`${head("Advertising posters", "Manage sponsored poster slots. Home page: the Featured rail below events and trending. Event discovery: the sponsored rail directly below Upcoming events.", isA() ? html`<button class="btn btn-primary" data-new>New poster</button>` : "")}
    ${list.length ? html`<div class="poster-rail">${list.map((p) => html`<article class="card flat stack">
      <div class="ad-poster">${p.image_upload_id ? html`<img src="/media/${p.image_upload_id}" alt="">` : ""}<div class="meta"><h3>${p.title}</h3>${p.subtitle ? html`<span>${p.subtitle}</span>` : ""}</div></div>
      <div class="row between"><span>${live(p) ? html`<span class="badge good">Live</span>` : p.active ? html`<span class="badge warn">Scheduled</span>` : html`<span class="badge">Paused</span>`} <span class="badge plain">${p.placement === "events" ? "Event discovery" : "Home page"}</span></span><span class="small muted">${p.clicks} clicks</span></div>
      <p class="small muted mb-0">${p.link_url || "No link"}${p.starts_at || p.ends_at ? html`<br>${p.starts_at ? fmtDate(p.starts_at) : "now"} – ${p.ends_at ? fmtDate(p.ends_at) : "no end"}` : ""}</p>
      ${isA() ? html`<div class="row"><button class="btn btn-ghost btn-sm" data-edit="${p.id}">Edit</button><button class="btn btn-ghost btn-sm" data-toggle="${p.id}">${p.active ? "Pause" : "Activate"}</button><button class="btn btn-ghost btn-sm" data-del="${p.id}">Delete</button></div>` : ""}</article>`)}</div>`
      : empty("No posters yet. Create one for the home page or event discovery rail.")}`);
  const editor = (p = {}) => {
    const d = dialog(p.id ? "Edit poster" : "New poster", html`<form class="stack">
      <div class="field"><label for="pt">Title</label><input id="pt" name="title" required maxlength="120" value="${p.title || ""}"></div>
      <div class="field"><label for="ps">Subtitle <span class="muted">(optional)</span></label><input id="ps" name="subtitle" maxlength="200" value="${p.subtitle || ""}"></div>
      <div class="field"><label for="pi">Image (16:9, PNG/JPEG/WebP, up to 2 MB)</label><input id="pi" type="file" accept="image/png,image/jpeg,image/webp"><input type="hidden" name="imageUploadId" value="${p.image_upload_id || ""}"></div>
      <div class="field"><label for="pl">Link <span class="muted">(/events/… or https://…)</span></label><input id="pl" name="linkUrl" maxlength="300" value="${p.link_url || ""}"></div>
      <div class="field"><label for="pp">Placement</label><select id="pp" name="placement"><option value="home" ${raw((p.placement || "home") === "home" ? "selected" : "")}>Home page Featured rail</option><option value="events" ${raw(p.placement === "events" ? "selected" : "")}>Event discovery sponsored rail</option></select><span class="hint">Choose where this sponsored poster appears on the public home page.</span></div>
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
      const body = { title: v.title, subtitle: v.subtitle, imageUploadId: v.imageUploadId || undefined, linkUrl: v.linkUrl || undefined, placement: v.placement, sortOrder: Number(v.sortOrder || 100),
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

async function careersAdmin() {
  if (!isA()) return render(main, html`<div class="card pad-lg stack"><h1>Careers</h1><p class="mb-0">Managing job posts needs the admin role.</p></div>`);
  const { jobs } = await get("/api/admin/jobs");
  const status = (j) => j.status === "published" ? html`<span class="badge good">Published</span>` : html`<span class="badge plain">Draft</span>`;
  render(main, html`${head("Careers", "Create and manage the vacancies shown on the public Careers page.", isA() ? html`<button class="btn btn-primary" data-new>New job post</button>` : "")}
    ${jobs.length ? tbl(["Role", "Department", "Location", "Status", "Closes", ""], jobs.map((j) => html`<tr><td><strong>${j.title}</strong><br><span class="small muted">${j.employment_type}</span></td><td>${j.department}</td><td>${j.location}</td><td>${status(j)}</td><td>${j.closes_at || "No date"}</td>
      <td class="nowrap">${isA() ? html`<button class="btn btn-ghost btn-sm" data-edit="${j.id}">Edit</button> <button class="btn btn-ghost btn-sm" data-publish="${j.id}">${j.status === "published" ? "Unpublish" : "Publish"}</button> <button class="btn btn-ghost btn-sm" data-delete="${j.id}">Delete</button>` : ""}</td></tr>`), "No job posts yet.") : empty("No job posts yet. Create a draft or publish your first vacancy.")}`);
  const editor = (j = {}) => {
    const d = dialog(j.id ? "Edit job post" : "New job post", html`<form class="stack">
      <div class="field"><label for="jp-title">Job title</label><input id="jp-title" name="title" required maxlength="120" value="${j.title || ""}" placeholder="Event Operations Coordinator"></div>
      <div class="grid-2"><div class="field"><label for="jp-dept">Department</label><input id="jp-dept" name="department" required maxlength="80" value="${j.department || ""}" placeholder="Operations"></div>
        <div class="field"><label for="jp-type">Employment type</label><input id="jp-type" name="employmentType" required maxlength="60" value="${j.employment_type || ""}" placeholder="Full-time"></div>
        <div class="field"><label for="jp-location">Location</label><input id="jp-location" name="location" required maxlength="120" value="${j.location || ""}" placeholder="Johannesburg or remote"></div>
        <div class="field"><label for="jp-close">Application closing date <span class="muted">(optional)</span></label><input id="jp-close" name="closesAt" type="date" value="${j.closes_at || ""}"></div></div>
      <div class="field"><label for="jp-summary">Short summary</label><textarea id="jp-summary" name="summary" required maxlength="300" rows="2">${j.summary || ""}</textarea></div>
      <div class="field"><label for="jp-description">Role description</label><textarea id="jp-description" name="description" required maxlength="12000" rows="10" placeholder="Responsibilities, experience and how to apply">${j.description || ""}</textarea><span class="hint">Plain text. Paragraph breaks are kept on the public page.</span></div>
      <div class="field"><label for="jp-apply">Application link</label><input id="jp-apply" name="applicationUrl" type="url" required maxlength="300" value="${j.application_url || ""}" placeholder="https://…"><span class="hint">Use a secure HTTPS link to your application form.</span></div>
      <div class="field"><label for="jp-status">Visibility</label><select id="jp-status" name="status"><option value="draft" ${raw(j.status !== "published" ? "selected" : "")}>Draft, not public</option><option value="published" ${raw(j.status === "published" ? "selected" : "")}>Published on Careers</option></select></div>
      <button class="btn btn-primary">${j.id ? "Save job post" : "Create job post"}</button></form>`);
    onSubmit($("form", d), async (v) => {
      const body = { title: v.title, department: v.department, location: v.location, employmentType: v.employmentType, summary: v.summary, description: v.description, applicationUrl: v.applicationUrl, closesAt: v.closesAt || undefined, status: v.status };
      if (j.id) await patch(`/api/admin/jobs/${j.id}`, body); else await post("/api/admin/jobs", body);
      d.close(); toast("Job post saved.", "good"); careersAdmin();
    });
  };
  $("[data-new]")?.addEventListener("click", () => editor());
  $$(`[data-edit]`).forEach((b) => b.addEventListener("click", () => editor(jobs.find((j) => j.id === b.dataset.edit))));
  $$(`[data-publish]`).forEach((b) => b.addEventListener("click", async () => {
    const j = jobs.find((x) => x.id === b.dataset.publish);
    if (await act(() => patch(`/api/admin/jobs/${j.id}`, { status: j.status === "published" ? "draft" : "published" }), j.status === "published" ? "Job post unpublished." : "Job post published.")) careersAdmin();
  }));
  $$(`[data-delete]`).forEach((b) => b.addEventListener("click", async () => {
    if (await confirmDialog("Delete this job post?", "This can't be undone.", { confirm: "Delete", danger: true }) && await act(() => del(`/api/admin/jobs/${b.dataset.delete}`), "Job post deleted.")) careersAdmin();
  }));
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
    <div class="mt">${tab === "kb" ? tbl(["Question", "Answer", "Link", "Status", ""], articles.map((a) => html`<tr><td><strong>${a.question}</strong><div class="tiny muted">${(a.keywords || []).join(", ")}</div></td><td class="small">${a.answer.slice(0, 220)}${a.answer.length > 220 ? "…" : ""}</td><td class="small mono">${a.link_url || ""}</td><td>${a.active ? badge("active") : html`<span class="badge">Off</span>`}</td>
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
  const groups = ["Attendee", "Everyone", "Organiser", "Subscriber", "Staff"];
  const auto = (e) => e.setting ? (st[e.setting] ? html`<span class="badge good">Automatic · on</span>` : html`<span class="badge">Automatic · off</span>`) : html`<span class="badge info">Sent when it happens</span>`;
  render(main, html`${head("Email templates", "Every email TicketRoom sends. Each is sent as a branded HTML email with a plain-text version.")}
    ${delivery === "log" ? html`<p class="callout bad"><strong>Emails are not being delivered.</strong> Set up the mailbox under <a href="#/integrations">Integrations</a> → Email, then send yourself a test.</p>` : ""}
    <section class="card stack"><h2>Automatic emails</h2>
      <form class="stack" id="f-em">
        <label class="check"><input type="checkbox" name="reminderDayBefore" ${raw(st.reminderDayBefore ? "checked" : "")} ${ro}><span><strong>Day-before reminder</strong> to every ticket holder, about 24 hours before the event</span></label>
        <label class="check"><input type="checkbox" name="reminderSoon" ${raw(st.reminderSoon ? "checked" : "")} ${ro}><span><strong>Starting-soon reminder</strong> within 3 hours of the start, with tips for the gate</span></label>
        <label class="check"><input type="checkbox" name="abandonedCheckout" ${raw(st.abandonedCheckout ? "checked" : "")} ${ro}><span><strong>Abandoned checkout</strong>: once per person per event, only while tickets are still on sale, never to people who unsubscribed</span></label>
        <div class="field"><label for="em-d">Send the abandoned-checkout email after</label><select id="em-d" name="abandonedDelayHours" ${ro}>${[1, 2, 3, 6, 12, 24].map((h) => html`<option value="${h}" ${raw(h === st.abandonedDelayHours ? "selected" : "")}>${h} hour${h === 1 ? "" : "s"}</option>`)}</select></div>
        <p class="tiny muted mb-0">Each email is sent at most once. Reminders need the background jobs cron (see the setup guide) or the app to be running.</p>
        ${isA() ? html`<div><button class="btn btn-dark">Save</button></div>` : ""}</form></section>
    ${groups.map((g) => html`<h2 class="mt-lg">${({ Attendee: "Customer emails", Everyone: "Account & support", Organiser: "Organiser emails", Subscriber: "Subscriber emails", Staff: "Staff emails" })[g]}</h2><div class="grid-2">${emails.filter((e) => e.audience === g).map((e) => html`<article class="card stack">
      <div class="row between"><h3 class="mb-0">${e.name}</h3>${auto(e)}</div>
      <p class="small muted mb-0">${e.trigger}</p>
      <p class="small mb-0"><strong>Subject:</strong> ${e.subject}</p>
      <div class="row"><button class="btn btn-ghost btn-sm" data-prev="${e.key}">Preview</button>${isA() ? html`<button class="btn btn-ghost btn-sm" data-test="${e.key}">Send a test</button>` : ""}</div></article>`)}</div>`)}`);
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
  $$("[data-test]").forEach((b) => b.addEventListener("click", async () => {
    const e = emails.find((x) => x.key === b.dataset.test);
    const to = await confirmDialog(`Send a test: ${e.name}`, "The email goes out straight away with sample details, marked [TEST] in the subject.", { confirm: "Send", input: { label: "Email address", type: "email", required: true, value: (await me()).email } });
    if (!to) return;
    try { const r = await post(`/api/admin/emails/${b.dataset.test}/test`, { to }); toast(r.detail, r.ok ? "good" : "bad"); } catch (err) { toast(err.message, "bad"); }
  }));
}

// ---------------- verification (FICA) ----------------
// Organiser documents waiting for a person to check them. Opening a document
// is logged and shown to the organiser.
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fileLink = (id, text = "Open") => html`<a class="btn btn-ghost btn-sm" href="/api/verification/documents/${id}/file" target="_blank" rel="noopener">${text}</a>`;
const providerNote = (p, label, simulated) => (p && p.status !== "manual" && p.outcome !== "manual"
  ? html`<div class="tiny ${simulated ? "callout warn" : "muted"}">${simulated ? html`<strong>Sandbox (simulated)</strong>` : label}: ${badge(p.outcome || p.status)} ${p.message || ""}</div>` : "");
async function kycDecide(id, approve, redraw) {
  let why;
  if (!approve) { why = await reason("Not accepted", "Tell the organiser what is wrong, so they can upload a better copy. They get this by email.", "What needs fixing"); if (!why) return; }
  if (await act(() => post(`/api/admin/verification/documents/${id}/decide`, approve ? { approve: true } : { approve: false, reason: why }), approve ? "Approved." : "Sent back to the organiser.")) redraw();
}
function kycDecideWire(root, redraw) {
  $$("[data-kyc-ok]", root).forEach((b) => b.addEventListener("click", () => kycDecide(b.dataset.kycOk, true, redraw)));
  $$("[data-kyc-no]", root).forEach((b) => b.addEventListener("click", () => kycDecide(b.dataset.kycNo, false, redraw)));
}
// VerifyNow checks: plain reasons, what was sent back (images and full ID and
// account numbers removed), and staff actions.
const CHECK_STATUS = { queued: "queued", running: "checking", waiting: "waiting for the bank", passed: "passed", review: "review", failed: "failed", error: "error", superseded: "replaced" };
function checkRow(c, withOrg = false) {
  const open = ["queued", "running", "waiting"].includes(c.status);
  const can = isA() || isS() || (isF() && c.type === "bank");
  return html`<li class="kyc-item" data-check="${c.id}" data-check-type="${c.type}"><div class="grow kyc-body">
    <div class="row"><strong>${c.label}</strong>${badge(c.status)}${c.override ? html`<span class="badge ${c.override === "accepted" ? "good" : "bad"}">${c.override} by staff</span>` : ""}${c.test ? html`<span class="badge warn">TEST</span>` : ""}</div>
    ${withOrg ? html`<div class="small"><a href="#/organisers/${c.organiserId}">${c.organiserName}</a> <span class="tiny muted mono">${c.organiserRef || ""}</span></div>` : ""}
    ${c.reasons.length ? html`<ul class="small mb-0">${c.reasons.map((r) => html`<li>${r}</li>`)}</ul>` : open ? html`<div class="small muted">${CHECK_STATUS[c.status]}${c.lastError ? `: ${c.lastError}` : ""}</div>` : ""}
    ${c.decisionNote ? html`<div class="tiny">Staff note: ${c.decisionNote}${c.decidedBy ? ` (${c.decidedBy})` : ""}</div>` : ""}
    <div class="tiny muted">${fmtDateTime(c.createdAt)}${c.providerRef ? html` · VerifyNow ref <span class="mono">${c.providerRef}</span>` : ""} · request key <span class="mono">${c.idempotencyKey}</span>${c.attempts > 1 ? ` · ${c.attempts} tries` : ""}${c.httpStatus ? ` · HTTP ${c.httpStatus}` : ""}</div>
    ${c.response ? html`<details class="tiny"><summary>What VerifyNow sent back</summary><pre class="mono small">${JSON.stringify(c.response, null, 2)}</pre></details>` : ""}</div>
    ${can && c.status !== "superseded" ? html`<div class="row">${!open ? html`<button class="btn btn-ghost btn-sm" data-check-rerun="${c.id}">Run again</button>` : ""}${!open && !c.override && c.status !== "passed" ? html`<button class="btn btn-good btn-sm" data-check-ok="${c.id}">Accept</button><button class="btn btn-ghost btn-sm" data-check-no="${c.id}">Reject</button>` : ""}</div>` : ""}</li>`;
}
function checkWire(root, redraw) {
  $$("[data-check-rerun]", root).forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/verification/checks/${b.dataset.checkRerun}/rerun`), "Queued. It runs in the background within a minute.")) redraw(); }));
  $$("[data-check-ok]", root).forEach((b) => b.addEventListener("click", async () => {
    const note = await confirmDialog("Accept this result?", "Say what you checked, for example that you compared the ID document. The organiser sees this note.", { confirm: "Accept", input: { label: "What you checked", required: true } });
    if (!note) return;
    if (await act(() => post(`/api/admin/verification/checks/${b.dataset.checkOk}/decide`, { accept: true, note }), "Accepted.")) redraw();
  }));
  $$("[data-check-no]", root).forEach((b) => b.addEventListener("click", async () => {
    const why = await reason("Not accepted", "Tell the organiser what is wrong, so they can fix their details.", "What needs fixing");
    if (why && await act(() => post(`/api/admin/verification/checks/${b.dataset.checkNo}/decide`, { accept: false, note: why }), "Sent back to the organiser.")) redraw();
  }));
}
async function verificationQueue() {
  const status = sessionStorage.getItem("adm_kyc") || "submitted";
  const r = await get(`/api/admin/verification?status=${status}`);
  const s = r.settings;
  render(main, html`${head("Verification", "Organiser documents (FICA). Open each one, compare it with the organiser's details, then approve it or say what is wrong.")}
    ${r.provider.simulated ? html`<p class="callout warn small"><strong>Identity checks are in sandbox mode (simulated).</strong> ${r.provider.rule} Switch to staff review or your own provider under <a href="#/integrations">Integrations</a> before going live.</p>` : html`<p class="small muted">Identity checks: ${r.provider.label}.</p>`}
    ${r.checks.length ? html`<section class="card mb"><h2>Electronic checks that need a look</h2><p class="small muted">VerifyNow could not confirm these by itself. Compare them with the documents, then accept, reject or run the check again.</p><ul class="kyc-list">${r.checks.map((c) => checkRow(c, true))}</ul></section>` : ""}
    <div class="row mb"><label for="kq-s">Show</label><select id="kq-s">${[["submitted", "Waiting for a check"], ["approved", "Approved recently"], ["rejected", "Not accepted recently"]].map(([k, l]) => html`<option value="${k}" ${raw(k === status ? "selected" : "")}>${l}</option>`)}</select></div>
    ${tbl(["Organiser", "Document", "Uploaded", "Identity check", "Status", ""], r.documents.map((d) => html`<tr><td><a href="#/organisers/${d.organiser_id}"><strong>${d.organiser_name}</strong></a><div class="tiny muted mono">${d.organiser_ref || ""}</div></td>
      <td>${d.label}${d.event_title ? html`<div class="tiny muted">Event: ${d.event_title}</div>` : ""}<div class="tiny muted">${(d.mime_type || "").split("/")[1]?.toUpperCase()} · ${kb(d.size_bytes)}</div></td>
      <td class="small">${fmtDateTime(d.created_at)}<div class="tiny muted">${d.uploaded_by_name || ""}</div></td>
      <td>${d.provider && d.provider !== "manual" ? providerNote({ outcome: d.provider_status, message: d.provider_message }, d.provider_label, d.provider === "sandbox") : html`<span class="tiny muted">staff review</span>`}</td>
      <td>${badge(d.status)}${d.reject_reason ? html`<div class="tiny muted">${d.reject_reason}</div>` : ""}${d.reviewed_by_name ? html`<div class="tiny muted">by ${d.reviewed_by_name}</div>` : ""}</td>
      <td><div class="row">${fileLink(d.id)}${d.status === "submitted" && d.canDecide ? html`<button class="btn btn-good btn-sm" data-kyc-ok="${d.id}">Approve</button><button class="btn btn-ghost btn-sm" data-kyc-no="${d.id}">Reject</button>` : ""}</div></td></tr>`),
      status === "submitted" ? "Nothing waiting. New uploads from organisers appear here." : "Nothing here yet.")}
    <section class="card mt"><h2>Keeping documents (POPIA)</h2>
      <p class="small">FICA records are kept for at least 5 years after an organiser's account closes, then deleted automatically. Copies that were replaced or not accepted are not records and are deleted sooner. Closing an organiser is done from its page.</p>
      <form class="stack" id="kset"><div class="grid-2"><div class="field"><label for="ks-y">Keep records for (years after closing)</label><input id="ks-y" name="retentionYears" type="number" min="5" max="10" required value="${s.retentionYears}" ${raw(isA() ? "" : "disabled")}><span class="hint">At least 5, as FICA requires.</span></div>
        <div class="field"><label for="ks-d">Delete replaced or rejected copies after (days)</label><input id="ks-d" name="discardRejectedDays" type="number" min="30" max="365" required value="${s.discardRejectedDays}" ${raw(isA() ? "" : "disabled")}></div></div>
        ${isA() ? html`<div><button class="btn btn-dark">Save keeping rules</button></div>` : html`<p class="small muted mb-0">Only admins can change these.</p>`}</form></section>`);
  $("#kq-s").addEventListener("change", (e) => { sessionStorage.setItem("adm_kyc", e.target.value); verificationQueue(); });
  if (isA()) onSubmit($("#kset"), async (v) => { await put("/api/admin/settings/verification", { retentionYears: Number(v.retentionYears), discardRejectedDays: Number(v.discardRejectedDays) }); toast("Keeping rules saved.", "good"); });
  kycDecideWire(main, verificationQueue);
  checkWire(main, verificationQueue);
}
const RISK_OPTS = [["auto", "Automatic (by the rules)"], ["high", "Always high risk"], ["normal", "Waive extra checks"]];
async function organiserDetail({ id }) {
  const { organiser: o, owners, verification: v, checks } = await get(`/api/admin/organisers/${id}/verification`);
  const p = v.profile;
  const redraw = () => organiserDetail({ id });
  const item = (it, eventId = "") => {
    const d = it.document;
    return html`<li class="kyc-item"><div class="grow kyc-body"><div class="row"><strong>${it.label}</strong>${badge(it.recommended ? "recommended" : it.status)}${it.required ? "" : html`<span class="badge plain">Not required</span>`}</div>
      <div class="tiny muted">${it.reason}</div>${it.detail ? html`<div class="tiny">${it.detail}</div>` : ""}${it.signed ? html`<div class="tiny">Signed by ${it.signed.name}, ${fmtDateTime(it.signed.at)} (${it.signed.version})</div>` : ""}
      ${it.rejectReason ? html`<div class="tiny">Not accepted: ${it.rejectReason}</div>` : ""}
      ${d && !d.deleted ? html`<div class="tiny muted">Uploaded ${fmtDateTime(d.uploadedAt)} · ${kb(d.sizeBytes)}${d.reviewedBy ? ` · checked by ${d.reviewedBy}` : ""}</div>${providerNote(d.provider, d.provider?.label, d.provider?.simulated)}` : ""}</div>
      ${d && !d.deleted ? html`<div class="row">${fileLink(d.id)}${d.status === "submitted" ? html`<button class="btn btn-good btn-sm" data-kyc-ok="${d.id}">Approve</button><button class="btn btn-ghost btn-sm" data-kyc-no="${d.id}">Reject</button>` : ""}</div>` : ""}</li>`;
  };
  const gateLi = (g, label) => html`<li>${g.ok ? badge("approved") : html`<span class="badge bad">Blocked</span>`} ${label}${g.missing.length ? html`<span class="tiny muted"> · needs ${g.missing.join(", ")}</span>` : ""}</li>`;
  render(main, html`<div class="crumbs"><a href="#/organisers">Organiser accounts</a></div>${head(o.name, html`<span class="mono">${o.ref || ""}</span> · ${badge(o.status)} · verification ${badge(v.overall)}`)}
    ${v.provider.simulated ? html`<p class="callout warn small"><strong>Sandbox (simulated) identity checks are on.</strong> ${v.provider.rule}</p>` : ""}
    <div class="grid-2"><section class="card"><h2>Organisation</h2><dl class="dl"><dt>Contact</dt><dd>${o.contact_email}${o.contact_phone ? html`<br>${o.contact_phone}` : ""}</dd>
        <dt>Owners</dt><dd>${owners.map((w) => html`<div>${w.full_name} · ${w.email} ${w.email_verified ? html`<span class="badge good">Email verified</span>` : html`<span class="badge warn">Email not verified</span>`}${w.phone ? html`<div class="tiny muted">${w.phone} (not verified: phone checks are not available yet)</div>` : ""}</div>`)}</dd>
        <dt>Bank</dt><dd>${o.bank_account_last4 ? html`${o.bank_name} · ${o.bank_account_holder} · ••••${o.bank_account_last4} · branch ${o.bank_branch_code} ${isA() || isF() ? html`<button class="btn btn-link btn-sm" data-reveal-bank>Show account number</button>` : ""}` : "Not given"}</dd>
        <dt>Sells paid tickets</dt><dd>${v.sellsPaid ? "Yes" : "No (free events only)"}</dd></dl></section>
      <section class="card"><h2>Who they are</h2><dl class="dl"><dt>Kind</dt><dd>${v.entityNames[p.entityType]}</dd><dt>${p.entityType === "individual" ? "Name" : "Representative"}</dt><dd>${p.legalName || "Not given"}</dd>
        <dt>${p.nationality === "foreign" ? "Passport" : "SA ID"}</dt><dd>${p.hasIdNumber ? html`${p.idNumberMasked}${p.dateOfBirth ? `, born ${p.dateOfBirth}` : ""} ${isA() || isS() ? html`<button class="btn btn-link btn-sm" data-reveal-id>Show number</button>` : ""}` : "Not given"}</dd>
        ${p.entityType !== "individual" ? html`<dt>Registration no.</dt><dd class="mono">${p.registrationNumber || "Not given"}</dd>` : ""}
        ${p.entityType === "company" ? html`<dt>Is a director</dt><dd>${p.repIsDirector ? "Yes" : "No (needs a letter of authorisation)"}</dd>` : ""}
        <dt>Account closed</dt><dd>${p.closedAt ? html`${fmtDate(p.closedAt)}: documents are deleted ${v.retention.years} years later` : "No"}</dd></dl>
        <p class="tiny muted mb-0">Each "Show" is recorded in the audit log and shown to the organiser.</p></section></div>
    <section class="card mt"><h2>What is unlocked</h2><ul class="small">${gateLi(v.gates.freePublish, "Free events can go live")}${gateLi(v.gates.paidPublish, "Paid events can go on sale")}${gateLi(v.gates.payouts, "Payouts")}</ul></section>
    <section class="card mt"><h2>Checklist</h2><ul class="kyc-list">${v.requirements.map((it) => item(it))}</ul></section>
    ${v.electronic.on || checks.length ? html`<section class="card mt"><div class="card-title"><h2>Electronic checks (VerifyNow)</h2>${v.electronic.test ? html`<span class="badge warn">TEST (sandbox)</span>` : ""}</div>
      <p class="small ${v.electronic.consent.given ? "muted" : ""}">${v.electronic.consent.given ? `Permission given ${fmtDateTime(v.electronic.consent.at)} (${v.electronic.consent.version}).` : "The organiser has not given permission for the checks yet. They are asked when they submit an event."}</p>
      ${checks.length ? html`<ul class="kyc-list">${checks.filter((c) => c.status !== "superseded").map((c) => checkRow(c))}</ul>
        ${checks.some((c) => c.status === "superseded") ? html`<details class="small"><summary>Earlier runs</summary><ul class="kyc-list">${checks.filter((c) => c.status === "superseded").map((c) => checkRow(c))}</ul></details>` : ""}` : html`<p class="muted small mb-0">No checks yet.</p>`}</section>` : ""}
    <section class="card mt"><div class="card-title"><h2>Risk and event documents</h2></div>
      <form class="row" id="orisk"><label for="or-sel">Organiser risk</label><select id="or-sel" name="riskOverride" ${raw(isA() ? "" : "disabled")}>${RISK_OPTS.map(([k, l]) => html`<option value="${k}" ${raw((p.riskOverride || "auto") === k ? "selected" : "")}>${l}</option>`)}</select>
        <input name="note" class="grow" maxlength="300" placeholder="Why (kept in the audit log)" value="${p.riskNote || ""}" aria-label="Why" ${raw(isA() ? "" : "disabled")}>${isA() ? html`<button class="btn btn-ghost btn-sm">Save</button>` : ""}</form>
      ${v.events.length ? v.events.map((e) => html`<div class="kyc-event"><div class="row between"><span><strong>${e.title}</strong> <span class="tiny muted mono">${e.ref || ""}</span> ${badge(e.status)} <span class="small muted">${fmtDate(e.startsAt)} · ${plural(e.capacity, "person", "people")}${e.paid ? " · paid" : " · free"}</span></span>
          <span>${e.risk.level === "high" ? html`<span class="badge bad">High risk</span>` : html`<span class="badge good">Standard</span>`}
          ${isA() ? html`<select data-ev-risk="${e.id}" aria-label="Risk for ${e.title}">${RISK_OPTS.map(([k, l]) => html`<option value="${k}" ${raw((e.risk.override || "auto") === k ? "selected" : "")}>${l}</option>`)}</select>` : ""}</span></div>
          ${e.risk.reasons.length ? html`<p class="tiny muted mb-0">${e.risk.reasons.join("; ")}</p>` : ""}
          ${e.requirements.length ? html`<ul class="kyc-list">${e.requirements.map((it) => item(it, e.id))}</ul>` : html`<p class="tiny muted mb-0">No event documents needed.</p>`}</div>`) : html`<p class="muted mb-0">No current events.</p>`}</section>
    <section class="card mt"><h2>Documents held</h2>${tbl(["Document", "Status", "Uploaded", "#Size"], v.held.map((h) => html`<tr><td>${h.label}${h.event ? html`<div class="tiny muted">${h.event}</div>` : ""}</td><td>${h.deletedAt ? html`<span class="badge plain">Deleted</span>` : badge(h.status)}</td><td class="small">${fmtDate(h.uploadedAt)}</td><td class="num small">${kb(h.sizeBytes)}</td></tr>`), "No documents.")}
      <h3 class="mt">Who opened them</h3>${v.accessLog.length ? html`<ul class="small">${v.accessLog.map((x) => html`<li>${fmtDateTime(x.at)}: ${x.who}, ${x.action.toLowerCase()}</li>`)}</ul>` : html`<p class="small muted">Nobody yet.</p>`}
      ${isA() ? html`<div class="row mt">${p.closedAt ? html`<button class="btn btn-ghost btn-sm" data-close-org="reopen">Reopen (stop the deletion countdown)</button>` : html`<button class="btn btn-ghost btn-sm" data-close-org="close">Mark the account closed</button>`}<span class="tiny muted">Closing starts the ${v.retention.years}-year keeping period; documents are then deleted automatically.</span></div>` : ""}</section>`);
  kycDecideWire(main, redraw);
  checkWire(main, redraw);
  if (isA()) {
    onSubmit($("#orisk"), async (x) => { await post(`/api/admin/organisers/${id}/verification/risk`, { riskOverride: x.riskOverride, note: x.note || undefined }); toast("Risk saved.", "good"); redraw(); });
    $$("[data-ev-risk]").forEach((s) => s.addEventListener("change", async () => { if (await act(() => post(`/api/admin/events/${s.dataset.evRisk}/risk`, { riskOverride: s.value }), "Event risk saved.")) redraw(); }));
    $("[data-close-org]")?.addEventListener("click", async (e) => {
      const reopen = e.target.dataset.closeOrg === "reopen";
      if (!reopen && !(await confirmDialog("Mark the account closed?", `Their verification documents will be deleted automatically ${v.retention.years} years from today. This does not suspend events; do that separately if needed.`, { confirm: "Mark closed" }))) return;
      if (await act(() => post(`/api/admin/organisers/${id}/verification/close`, { reopen }), reopen ? "Reopened." : "Marked closed.")) redraw();
    });
  }
  $("[data-reveal-id]")?.addEventListener("click", async () => { try { const r = await post(`/api/admin/organisers/${id}/verification/reveal-id`); dialog("ID number", html`<p class="mono">${r.idNumber}</p><p class="tiny muted">This view was recorded in the audit log and is shown to the organiser.</p>`); } catch (err) { toast(err.message, "bad"); } });
  $("[data-reveal-bank]")?.addEventListener("click", async () => { try { const r = await post(`/api/admin/organisers/${id}/verification/reveal-bank`); dialog("Account number", html`<p class="mono">${r.accountNumber}</p><p class="tiny muted">This view was recorded in the audit log and is shown to the organiser.</p>`); } catch (err) { toast(err.message, "bad"); } });
}

// ---------------- integrations ----------------
// Integrations: TicketRoom sets up its own email, card payments and SMS here.
// Keys and passwords go to the server, encrypted, and never come back: the
// page only shows whether each one is saved. Saving asks for your password.
const INTEG_HELP = {
  payments: "Choose your payment provider and save separate sandbox and production credentials. Start in Test mode, complete a Peach sandbox checkout, then switch to Live only after it is verified.",
  payouts: "Choose manual EFT or Peach Payments. Test approved payouts in Peach sandbox first; sandbox transfers never settle real organiser balances. Production transfers require a separate finance action after approval and cannot be recalled.",
  email: "The mailbox TicketRoom sends from: confirmations, tickets, password links and updates.",
  sms: "Optional. Buyers who give a mobile number get a short SMS with their tickets. Use BulkSMS or Clickatell, or connect your own provider through its web API.",
  verifynow: "Electronic checks on organisers by VerifyNow: SA ID numbers with Home Affairs (always), and the checks you choose below. They run in the background after the organiser gives permission, and anything VerifyNow cannot confirm comes to Verification for a person to decide.",
  identity: "How organisers' ID documents are checked (FICA). Staff review works now. The sandbox simulates a provider for testing. Your own provider is called with the ID number when an ID document is uploaded; anything it does not confirm goes to staff.",
  google: "Optional. Lets customers and organisers sign in or sign up with their Google account, no password needed. Staff always use the admin password sign-in.",
};
// Write-only boxes: never pre-filled, and kept out of the browser's password
// filling (they open for typing only when tapped).
const writeOnly = (id, name, plain, set) => html`<input id="${id}" name="${name}" type="${plain ? "text" : "password"}" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore data-bwignore readonly data-unlock placeholder="${set ? "Saved. Leave blank to keep it." : ""}" ${raw(isA() ? "" : "disabled")}>`;
function integrationCard(i) {
  const field = (f) => f.options
    ? html`<div class="field"${raw(f.provider ? ` data-for="${f.provider}"` : "")}><label for="ig-${i.key}-${f.name}">${f.label}</label><select id="ig-${i.key}-${f.name}" name="${f.name}" ${raw(isA() ? "" : "disabled")}>${Object.entries(f.options).map(([v, l]) => html`<option value="${v}" ${raw(v === f.value ? "selected" : "")}>${l}</option>`)}</select>${f.hint ? html`<span class="hint">${f.hint}</span>` : ""}</div>`
    : f.auto
      ? html`<div class="field"${raw(f.provider ? ` data-for="${f.provider}"` : "")}><span class="label">${f.label}</span><p class="mb-0">${f.set ? html`<span class="badge good">Connected</span>` : html`<span class="badge plain">Not connected yet</span>`}</p>${f.hint ? html`<span class="hint">${f.hint}</span>` : ""}</div>`
    : f.secret
      ? html`<div class="field"${raw(f.provider ? ` data-for="${f.provider}"` : "")}><label for="ig-${i.key}-${f.name}">${f.label} ${f.set ? html`<span class="badge good">Saved</span>` : html`<span class="badge plain">Not set</span>`}</label>
          ${writeOnly(`ig-${i.key}-${f.name}`, f.name, f.plain, f.set)}${f.hint ? html`<span class="hint">${f.hint}</span>` : ""}</div>`
      : html`<div class="field"${raw(f.provider ? ` data-for="${f.provider}"` : "")}><label for="ig-${i.key}-${f.name}">${f.label}</label><input id="ig-${i.key}-${f.name}" name="${f.name}" value="${f.value || ""}" placeholder="${f.placeholder || ""}" autocomplete="off" ${raw(isA() ? "" : "disabled")}>${f.hint ? html`<span class="hint">${f.hint}</span>` : ""}</div>`;
  return html`<section class="card stack integ" data-integ="${i.key}">
    <div class="row between"><h2 class="mb-0">${i.label}</h2><span>${badge(i.status === "active" ? "active" : "draft")}${i.status === "active" ? html` <span class="badge ${i.environment === "live" ? "good" : "warn"}">${sentence(i.environment)}</span>` : html` <span class="badge plain">Not set up</span>`}</span></div>
    <p class="muted mb-0">${INTEG_HELP[i.key] || ""}</p>
    ${i.key === "payments" && isA() && i.environment !== "live" ? html`<div class="callout small stack"><span><strong>Want to try payments now?</strong> The TicketRoom sandbox needs no provider account: buyers see a practice payment page and choose whether it goes through. PayFast's shared test account sends you through PayFast's own sandbox instead. Either way no real money moves and every ticket is marked TEST. Switch to your own keys and Live when you're ready.</span>
      <div class="row"><button type="button" class="btn btn-primary btn-sm" data-sandbox="ticketroom">Use the TicketRoom sandbox</button><button type="button" class="btn btn-ghost btn-sm" data-sandbox="payfast">Use PayFast's test account</button></div></div>` : ""}
    ${i.key === "payments" && i.testOrders ? html`<div class="callout warn small row between"><span><strong>${i.testOrders} test order${i.testOrders === 1 ? "" : "s"}</strong> on record. They never count as sales or payouts. Clear them before you go live to free their seats.</span>${isA() ? html`<button type="button" class="btn btn-ghost btn-sm" data-clear-test>Clear test orders</button>` : ""}</div>` : ""}
    ${i.key === "identity" && i.sandboxRule ? html`<p class="callout warn small mb-0"><strong>Sandbox (simulated):</strong> ${i.sandboxRule}</p>` : ""}
    ${i.key === "identity" && i.pending ? html`<p class="small mb-0"><a href="#/verification">${i.pending} document${i.pending === 1 ? "" : "s"} waiting for a check</a></p>` : ""}
    ${i.key === "verifynow" && i.test ? html`<p class="callout warn small mb-0"><strong>TEST (sandbox):</strong> VerifyNow returns synthetic results and nothing real is checked. Checks run in this mode are marked TEST. Switch to Production with a live key before relying on them.</p>` : ""}
    ${i.key === "verifynow" && i.problem ? html`<p class="callout bad small mb-0"><strong>Problem:</strong> ${i.problem}</p>` : ""}
    ${i.key === "verifynow" ? html`<p class="small mb-0" data-vn-credits>Credits: ${i.credits && i.credits.credits != null ? html`<strong>${i.credits.credits}</strong> <span class="tiny muted">(at ${fmtDateTime(i.credits.at)})</span>` : "press Test connection to see the balance"}.${i.running ? ` ${i.running} check${i.running === 1 ? "" : "s"} running.` : ""}${i.waiting ? html` <a href="#/verification">${i.waiting} check${i.waiting === 1 ? "" : "s"} waiting for a person</a>.` : ""}</p>
      <p class="small mb-0">Bank check results arrive at <span class="mono">${i.notifyUrl}</span>, signed with the secret TicketRoom made. Nothing to set up in VerifyNow: the address is sent with each check.</p>` : ""}
    ${i.redirectUrl ? html`<p class="small mb-0">In Google Cloud, create an OAuth client ID (Web application) and add this under Authorised redirect URIs: <span class="mono">${i.redirectUrl}</span></p>` : ""}
    ${i.key === "payouts" && i.provider === "peach" ? html`<p class="callout warn small mb-0"><strong>Sandbox and production are separate.</strong> Sandbox lets finance submit test payouts against Peach’s sandbox after approval; these never settle or reduce real organiser balances. Production transfers are irreversible, must be pre-funded, and require careful beneficiary checks. Configure this URL in Peach’s Payouts webhook settings and request a source-of-funds review before your first live payout.</p>` : ""}
    ${i.notifyUrl && i.key !== "verifynow" ? html`<p class="small mb-0">${i.key === "payouts" ? "Payout status webhook:" : "Payment notifications arrive at"} <span class="mono">${i.notifyUrl}</span>${i.provider === "yoco" ? " (registered with Yoco for you when you save)." : i.provider === "peach" && i.key === "payments" ? " Configure this URL on your Peach Checkout profile and add the custom header X-TicketRoom-Peach-Secret using the saved webhook secret." : i.provider === "peach" ? " Configure this endpoint in Peach Payouts and provide the signing secret from Peach." : ". PayFast is told this address with every payment."}</p>` : ""}
    <form class="stack" data-form="${i.key}" autocomplete="off"><div class="grid-2">${i.fields.map(field)}</div>
      ${isA() ? html`<div class="row"><button class="btn btn-primary">Save ${i.label.toLowerCase()} settings</button><button type="button" class="btn btn-ghost" data-health="${i.key}">${i.key === "verifynow" ? "Test connection" : "Check connection"}</button>
          ${i.key === "payments" && i.provider === "yoco" ? html`<button type="button" class="btn btn-ghost" data-yoco-page="test">Test payment page (Test)</button><button type="button" class="btn btn-ghost" data-yoco-page="live">Test payment page (Live)</button>` : ""}
          ${i.key === "email" ? html`<button type="button" class="btn btn-ghost" data-test="email">Send a test email</button>` : i.key === "sms" ? html`<button type="button" class="btn btn-ghost" data-test="sms">Send a test SMS</button>` : i.key === "identity" ? html`<button type="button" class="btn btn-ghost" data-test="identity">Try a check</button>` : ""}</div>
        <p class="tiny muted mb-0">Saving asks for your password. Saved keys and passwords are encrypted and never shown again, not even to admins.</p>` : html`<p class="small muted mb-0">Only admins can change these settings.</p>`}
    </form></section>`;
}
// Saving provider settings needs the admin's own password, asked fresh each time.
const askPassword = (what) => confirmDialog(`Save ${what}?`, "Type your TicketRoom password to confirm. These settings send email as TicketRoom and move money.", { confirm: "Save", input: { label: "Your password", type: "password", required: true, autocomplete: "current-password" } });
async function integrations() {
  const d = await get("/api/admin/integrations");
  const editable = d.integrations.every((i) => i.fields);
  render(main, html`${head("Integrations", editable ? "Set up email, card payments, SMS and identity checks yourself. Keys, passwords and usernames are stored encrypted and are never shown again: you only see whether each one is saved." : "TicketRoom's own provider accounts. Passwords and keys stay on the server and are never shown here. You only see whether each one is set.")}
    <p class="callout small">Current standard: ${moneyExact(d.defaults.bookingFeeCents)} service fee per paid ticket${d.defaults.bookingFeeBps ? ` + ${d.defaults.bookingFeeBps / 100}%` : ""}. Organisers can cover the service fee or have customers pay it. Commission is ${d.defaults.organiserCommissionBps / 100}% + ${moneyExact(d.defaults.organiserCommissionFixedCents)} per paid ticket (percentage override per organiser under Organisers). Free events pay nothing.</p>
    <div class="stack">${d.integrations.map((i) => i.fields ? integrationCard(i) : html`<section class="card stack"><div class="row between"><h2 class="mb-0">${i.label}</h2><span>${badge(i.provider === "none" || i.provider === "disabled" ? "draft" : "active")} <span class="badge ${i.environment === "live" ? "good" : "warn"}">${sentence(i.environment) || "Not set"}</span></span></div>
      <dl class="dl"><dt>Provider</dt><dd>${i.provider}</dd><dt>Endpoint</dt><dd class="mono small">${i.endpoint || "–"}</dd>${i.webhookUrl ? html`<dt>Webhook URL</dt><dd class="mono small">${i.webhookUrl}</dd>` : ""}
        ${Object.entries(i.credentials || {}).map(([k, v]) => html`<dt>${k}</dt><dd>${v === "set" ? html`<span class="badge good">Set</span>` : html`<span class="badge bad">Missing</span>`}</dd>`)}
        <dt>Last 24h</dt><dd>${i.calls || 0} calls, ${i.failures || 0} failures${i.avg_ms ? `, avg ${i.avg_ms} ms` : ""}${i.problems ? html` · <span class="badge bad">${i.problems} webhook problems</span>` : ""}</dd></dl>
      ${isA() ? html`<div><button class="btn btn-ghost btn-sm" data-health="${i.key}">Run health check</button></div>` : ""}</section>`)}</div>`);
  // Write-only boxes open for typing only when tapped, so browsers never fill saved logins into them.
  // Opened on touch-down, so the phone keyboard appears on the first tap; keyboard users open it on focus.
  $$("[data-unlock]").forEach((el) => { const open = () => el.removeAttribute("readonly"); for (const ev of ["pointerdown", "touchstart", "focus"]) el.addEventListener(ev, open, { once: true, passive: true }); });
  // Show only the fields for the chosen provider.
  $$("[data-form]").forEach((f) => {
    const sel = f.elements.provider || f.elements.payoutProvider;
    const sync = () => $$("[data-for]", f).forEach((x) => x.classList.toggle("hidden", !sel || x.dataset.for !== sel.value));
    sel?.addEventListener("change", sync); sync();
    onSubmit(f, async () => {
      const values = {};
      for (const el of f.elements) if (el.name && !el.closest(".hidden")) values[el.name] = el.value;
      const card = d.integrations.find((x) => x.key === f.dataset.form);
      const pw = await askPassword(`${card.label.toLowerCase()} settings`);
      if (!pw) return;
      const r = await put(`/api/admin/integrations/${f.dataset.form}`, { currentPassword: pw, values });
      toast([r.warning, r.notice].filter(Boolean).join(" ") || (r.changed.length ? "Saved." : "Nothing changed."), r.warning ? "bad" : "good");
      integrations();
    });
  });
  $$("[data-sandbox]").forEach((b) => b.addEventListener("click", async () => {
    const kind = b.dataset.sandbox;
    const pw = await askPassword(kind === "payfast" ? "PayFast's test account" : "the TicketRoom sandbox");
    if (!pw) return;
    try { const r = await post("/api/admin/integrations/payments/sandbox", { currentPassword: pw, kind }); toast(r.message, "good"); integrations(); } catch (err) { toast(err.message, "bad"); }
  }));
  $("[data-clear-test]")?.addEventListener("click", async () => {
    const pw = await confirmDialog("Clear test orders?", "Test tickets are cancelled and their seats go back on sale. Real orders are not touched. Type your password to confirm.", { confirm: "Clear test orders", danger: true, input: { label: "Your password", type: "password", required: true, autocomplete: "current-password" } });
    if (!pw) return;
    try { const r = await post("/api/admin/payments/clear-test", { currentPassword: pw }); toast(`Cleared ${r.cleared.orders} test order${r.cleared.orders === 1 ? "" : "s"}.`, "good"); integrations(); } catch (err) { toast(err.message, "bad"); }
  });
  // Yoco: open a R5 payment page made by this server with the chosen mode's key.
  $$("[data-yoco-page]").forEach((b) => b.addEventListener("click", async () => {
    const mode = b.dataset.yocoPage;
    if (mode === "live" && !(await confirmDialog("Open a LIVE payment page?", "Yoco will open a real R5.00 payment page. Use it to see what buyers see, but do not pay: a live payment is a real charge.", { confirm: "Open live page" }))) return;
    const tab = window.open("", "_blank"); // opened now, so the browser does not block it as a pop-up
    try {
      const r = await post("/api/admin/integrations/payments/yoco-test-page", { mode });
      if (r.ok && r.url) { if (tab) { tab.opener = null; tab.location.href = r.url; } else location.href = r.url; toast(r.detail, "good"); }
      else { if (tab) tab.close(); toast(`Problem: ${r.detail || "Yoco did not open a page."}`, "bad"); }
    } catch (err) { if (tab) tab.close(); toast(err.message, "bad"); }
  }));
  $$("[data-health]").forEach((b) => b.addEventListener("click", async () => {
    try { const r = await post(`/api/admin/integrations/${b.dataset.health}/health`); toast(r.ok ? `Working. ${r.detail || ""}` : `Problem: ${r.error || r.detail || "check failed"}`, r.ok ? "good" : "bad"); if (b.dataset.health === "verifynow") integrations(); }
    catch (err) { toast(err.message, "bad"); }
  }));
  $$("[data-test]").forEach((b) => b.addEventListener("click", async () => {
    let body = {};
    if (b.dataset.test === "identity") { const number = await confirmDialog("Try an identity check", "Type a test SA ID or passport number. It is checked on this server first, then sent to the provider you saved. Nothing is stored.", { confirm: "Check", input: { label: "ID or passport number", required: true } }); if (!number) return; body = { number }; }
    else if (b.dataset.test === "sms") { const phone = await confirmDialog("Send a test SMS", "We'll send one short SMS to this number.", { confirm: "Send", input: { label: "Mobile number", required: true, placeholder: "082 123 4567", type: "tel" } }); if (!phone) return; body = { phone }; }
    else { const to = await confirmDialog("Send a test email", "We'll send one short email to this address straight away and tell you what happened.", { confirm: "Send", input: { label: "Email address", type: "email", required: true, value: (await me()).email } }); if (!to) return; body = { to }; }
    b.disabled = true;
    try { const r = await post(`/api/admin/integrations/${b.dataset.test}/test`, body); toast(r.detail, r.ok ? "good" : "bad"); } catch (err) { toast(err.message, "bad"); } finally { b.disabled = false; }
  }));
}

(async () => {
  // Nothing on this page says "admin" until a staff account has signed in.
  // Staff who are already signed in get the admin header in one go.
  const signedIn = await me();
  await header($("#header"), roles(signedIn).size ? { portal: "admin" } : { box: "admin" });
  // A new-password link a staff member was sent opens here, signed out.
  if (emailLinkPage("admin")) return;
  const u = await requireUser("TicketRoom staff sign in.", "admin");
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
  router([["/", overview], ["/organisers", organisers], ["/organisers/:id", (p) => organiserDetail(p)], ["/verification", verificationQueue], ["/events", events], ["/event-changes", eventChangeRequests], ["/promo-codes", promoCodes], ["/users", users], ["/lookup", lookup], ["/tags", gate("tags", tags)], ["/terminals", gate("pos", terminals)], ["/wallets", gate("cashDesk", wallets)], ["/support", support], ["/promotions", promotions],
    ["/refunds", gate("finance", refunds)], ["/payouts", gate("finance", payouts)], ["/payments", gate("finance", payments)], ["/reconciliation", gate("finance", reconciliation)], ["/ledger", gate("finance", ledgerPage)], ["/retail-partners", retailPartners], ["/audit", audit], ["/outbox", outbox], ["/backups", backups], ["/site", siteSettings], ["/posters", posters], ["/careers", careersAdmin], ["/assistant", assistantPage], ["/emails", emailsPage], ["/integrations", integrations], ["/password", myPassword], ["/subscribers", subscribers], ["/qr", qrStudio], ["/staff", staffPage]], () => { location.hash = "#/"; });
})();
