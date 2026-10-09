// TicketRoom back office. The server enforces every permission; the UI only
// hides what a role cannot do.
import { html, raw, render, $, $$, get, post, money, moneyExact, fmtDate, fmtDateTime, header, requireUser, toast, onSubmit, badge, empty, spinner, dialog, confirmDialog, router, roles, me } from "/assets/core.js";

const main = $("#main");
let R = new Set();
const isA = () => R.has("admin"), isF = () => R.has("finance"), isS = () => R.has("support");
const head = (t, s = "", a = "") => html`<div class="page-head"><div><h1>${t}</h1>${s ? html`<p class="muted">${s}</p>` : ""}</div><div class="row">${a}</div></div>`;
const tbl = (cols, rows) => rows.length ? html`<div class="table-wrap"><table><thead><tr>${cols.map((c) => html`<th class="${c.startsWith("#") ? "num" : ""}">${c.replace("#", "")}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>` : empty("Nothing here.");
const act = async (fn, msg = "Done.") => { try { await fn(); toast(msg, "good"); return true; } catch (err) { toast(err.message, "bad"); return false; } };
const reason = (title, msg, label = "Reason") => confirmDialog(title, msg, { confirm: "Confirm", input: { label, required: true } });

function nav(counts = {}) {
  const c = (n) => (n ? html`<span class="count">${n}</span>` : "");
  render($("#sidenav"), html`<a href="#/">📊 Overview</a>
    <div class="sect">Operations</div><a href="#/organisers">🏢 Organisers${c(counts.orgs)}</a><a href="#/events">🎫 Events${c(counts.events)}</a><a href="#/users">👤 Users</a><a href="#/lookup">🔎 Orders & tickets</a><a href="#/tags">📶 Tags</a><a href="#/terminals">🧾 Terminals</a><a href="#/support">💬 Support${c(counts.support)}</a>
    <div class="sect">Finance</div><a href="#/refunds">↩️ Refunds${c(counts.refunds)}</a><a href="#/payouts">💰 Payouts${c(counts.payouts)}</a><a href="#/payments">💳 Payments & webhooks</a><a href="#/reconciliation">⚖️ Reconciliation${c(counts.recon)}</a><a href="#/ledger">📒 Ledger</a>
    <div class="sect">Governance</div><a href="#/audit">🛡️ Audit log</a><a href="#/outbox">✉️ Messages</a>`);
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
      ${alert(d.ops.stale_payments, "payments pending > 30 min — re-check with provider", "#/payments")}
      ${alert(d.ops.recon_exceptions, "unresolved reconciliation exceptions", "#/reconciliation", "bad")}
      ${alert(d.ops.messages_failed, "messages failed to send", "#/outbox", "bad")}
      ${alert(d.ops.support_open, "open support cases", "#/support")}
      ${Object.values(d.ops).every((x) => !x) && !d.organisers.pending && !d.events.pending ? html`<p class="callout good mb-0">All clear.</p>` : ""}</div></section>
    <section class="card mt"><h2>Ledger integrity</h2><p class="${d.ledger.balanced ? "callout good" : "callout bad"}">${d.ledger.balanced ? `Balanced: ${d.ledger.entries} entries sum to R0.00.` : `UNBALANCED — investigate journals ${d.ledger.unbalancedJournals.join(", ")}`}</p>
      ${tbl(["Provider clearing", "#Ledger", "#Expected", "Check"], d.ledger.clearing.map((c) => html`<tr><td class="mono">${c.account}</td><td class="num">${moneyExact(c.ledgerCents)}</td><td class="num">${moneyExact(c.expectedCents)}</td><td>${badge(c.ok ? "matched" : "failed")}</td></tr>`))}</section>`);
}

async function organisers() {
  const { organisers: list } = await get("/api/admin/organisers");
  render(main, html`${head("Organisers")}${tbl(["Organiser", "Owner", "Contact", "Events", "Bank", "Status", ""], list.map((o) => html`<tr><td><strong>${o.name}</strong><div class="tiny muted">${fmtDate(o.created_at)}</div></td><td>${o.owner_name || ""}</td><td class="small">${o.contact_email}<br>${o.contact_phone || ""}</td><td>${o.events}</td><td>${o.bank_account_last4 ? `••${o.bank_account_last4}` : "—"}</td><td>${badge(o.status)}</td>
    <td>${isA() ? html`<div class="row">${o.status !== "approved" ? html`<button class="btn btn-good btn-sm" data-s="approved" data-id="${o.id}">Approve</button>` : ""}${o.status === "pending" ? html`<button class="btn btn-ghost btn-sm" data-s="rejected" data-id="${o.id}">Reject</button>` : ""}${o.status === "approved" ? html`<button class="btn btn-ghost btn-sm" data-s="suspended" data-id="${o.id}">Suspend</button>` : ""}</div>` : ""}</td></tr>`))}`);
  $$("[data-s]").forEach((b) => b.addEventListener("click", async () => {
    const why = b.dataset.s === "approved" ? "" : await reason(`${b.dataset.s === "rejected" ? "Reject" : "Suspend"} organiser`, b.dataset.s === "suspended" ? "Their published events will be suspended too." : "They will be told.");
    if (why === false) return;
    if (await act(() => post(`/api/admin/organisers/${b.dataset.id}/status`, { status: b.dataset.s, reason: why || undefined }))) organisers();
  }));
}

async function events() {
  const filter = sessionStorage.getItem("adm_ev") || "pending_approval";
  const { events: list } = await get(`/api/admin/events${filter === "all" ? "" : `?status=${filter}`}`);
  render(main, html`${head("Events")}<div class="chips">${[["pending_approval", "Awaiting approval"], ["cancel_requests", "Cancellation requests"], ["published", "Published"], ["suspended", "Suspended"], ["all", "All"]].map(([k, l]) => html`<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`)}</div>
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
  render(main, html`${head("Users")}<form class="row" id="us"><input id="uq" class="grow" placeholder="Search name, email or phone" aria-label="Search users"><button class="btn btn-ghost">Search</button></form><div id="ul" class="mt">${spinner()}</div>`);
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
    ${!isF() ? html`<p class="callout">View only — refund approvals need the finance role.</p>` : ""}
    <div class="chips">${["requested", "failed", "completed", "rejected", "all"].map((k) => html`<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${k}</button>`)}</div>
    <div class="mt">${tbl(["Ref", "Event", "Type", "Reason", "By", "#Amount", "Status", ""], list.map((r) => html`<tr><td class="mono">${r.reference}${r.order_reference ? html`<div class="tiny muted">${r.order_reference}</div>` : ""}</td><td>${r.event_title}</td><td>${r.kind.replace("_", " ")}</td><td class="small">${r.reason}${r.failure_reason ? html`<div class="tiny">⚠ ${r.failure_reason}</div>` : ""}</td><td class="small">${r.requested_by_name || "system"}${r.decided_by_name ? html`<div class="tiny muted">decided: ${r.decided_by_name}</div>` : ""}</td>
      <td class="num">${moneyExact(r.amount_cents + r.fee_refund_cents)}</td><td>${badge(r.status)}</td>
      <td>${isF() && r.status === "requested" && !r.mine ? html`<div class="row"><button class="btn btn-good btn-sm" data-ok="${r.id}">Approve</button><button class="btn btn-ghost btn-sm" data-no="${r.id}">Reject</button></div>` : ""}
        ${isF() && r.status === "failed" ? html`<button class="btn btn-ghost btn-sm" data-retry="${r.id}">Retry</button>` : ""}${r.mine && r.status === "requested" ? html`<span class="tiny muted">yours — needs someone else</span>` : ""}</td></tr>`))}</div>`);
  $$("[data-f]").forEach((b) => b.addEventListener("click", () => { sessionStorage.setItem("adm_rf", b.dataset.f); refunds(); }));
  $$("[data-ok]").forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/refunds/${b.dataset.ok}/decide`, { approve: true }), "Approved and processed.")) refunds(); }));
  $$("[data-no]").forEach((b) => b.addEventListener("click", async () => { const why = await reason("Reject refund", "The requester will see this note."); if (why && await act(() => post(`/api/admin/refunds/${b.dataset.no}/decide`, { approve: false, note: why }))) refunds(); }));
  $$("[data-retry]").forEach((b) => b.addEventListener("click", async () => { if (await act(() => post(`/api/admin/refunds/${b.dataset.retry}/retry`), "Retried.")) refunds(); }));
  $("[data-bulk]")?.addEventListener("click", async () => {
    if (!(await confirmDialog("Approve refunds", `Approve and process ${actionable.length} refunds?`, { confirm: "Approve all" }))) return;
    const r = await post("/api/admin/refunds/bulk-approve", { refundIds: actionable.map((x) => x.id) });
    toast(`${r.results.filter((x) => !x.error).length} processed, ${r.results.filter((x) => x.error).length} failed.`, "good"); refunds();
  });
}

async function payouts() {
  const { payouts: list } = await get("/api/admin/payouts");
  render(main, html`${head("Payouts", "TicketRoom does not move money automatically. Approve, make the EFT through TitoPay's banking process, then record it here with the bank reference.")}
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
  render(main, html`${head("Payments & webhooks", "A payment is confirmed only by a verified provider webhook or a direct status query — never by the buyer's browser.")}
    <h2>Payments</h2>${tbl(["When", "Purpose", "User", "Provider ref", "#Amount", "Status", ""], list.map((p) => html`<tr><td class="small">${fmtDateTime(p.created_at)}</td><td>${p.purpose}</td><td class="small">${p.email}</td><td class="mono small">${p.provider_reference || "—"}</td><td class="num">${moneyExact(p.amount_cents)}${p.refunded_cents ? html`<div class="tiny">−${moneyExact(p.refunded_cents)}</div>` : ""}</td><td>${badge(p.status)}${p.failure_reason ? html`<div class="tiny muted">${p.failure_reason}</div>` : ""}</td>
      <td>${["pending", "cancelled", "failed"].includes(p.status) && p.provider_reference ? html`<button class="btn btn-ghost btn-sm" data-re="${p.id}">Re-check</button>` : ""}</td></tr>`))}
    <h2 class="mt-lg">Webhook deliveries</h2>${tbl(["Received", "Event id", "Signature", "Attempts", "Status", "Error"], webhooks.map((w) => html`<tr><td class="small">${fmtDateTime(w.received_at)}</td><td class="mono small">${w.provider_event_id}</td><td>${w.signature_valid ? "valid" : html`<span class="badge bad">invalid</span>`}</td><td>${w.attempts}</td><td>${badge(w.status)}</td><td class="small">${w.error || ""}</td></tr>`))}`);
  $$("[data-re]").forEach((b) => b.addEventListener("click", async () => { try { const r = await post(`/api/admin/payments/${b.dataset.re}/recheck`); toast(`Provider says: ${r.result}`, "good"); payments(); } catch (err) { toast(err.message, "bad"); } }));
}

async function reconciliation() {
  const { runs, ledger } = await get("/api/admin/reconciliation");
  const today = new Date(); const from = new Date(today.getTime() - 7 * 864e5);
  render(main, html`${head("Reconciliation", "Compare TicketRoom's records with the provider's report. Every difference must be resolved with a note — nothing is auto-corrected.")}
    ${isF() ? html`<section class="card"><h2>New run</h2><form class="stack" id="rf"><div class="grid-3"><div class="field"><label for="rp">Provider</label><select id="rp" name="provider"><option value="simulated">simulated</option></select></div>
      <div class="field"><label for="rfr">From</label><input id="rfr" name="from" type="date" value="${from.toISOString().slice(0, 10)}"></div><div class="field"><label for="rto">To (exclusive)</label><input id="rto" name="to" type="date" value="${new Date(today.getTime() + 864e5).toISOString().slice(0, 10)}"></div></div>
      <div class="field"><label for="rc">Provider CSV <span class="muted">(optional — otherwise fetched from the provider)</span></label><textarea id="rc" name="csv" placeholder="reference,amount_cents,status,refunded_cents,fee_cents"></textarea></div><button class="btn btn-dark">Run reconciliation</button></form></section>` : ""}
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
      <p class="callout warn small mb-0"><strong>Security:</strong> UID-only tags are identifiers, not credentials — they are easy to clone and are refused for payments by default. Generated tokens on QR/NDEF can be copied too; pair them with spending PINs and limits. Cryptographic tags (e.g. NTAG 424 DNA SUN) are not yet supported.</p>
      <button class="btn btn-dark">Create batch & download CSV</button></form></section>` : ""}
    <h2 class="mt-lg">Search</h2><form class="row" id="ts"><input id="tqq" class="grow mono" placeholder="Tag code" aria-label="Tag code"><button class="btn btn-ghost">Search</button></form><div id="tl" class="mt">${spinner()}</div>`);
  if ($("#bf")) onSubmit($("#bf"), async (v) => {
    const body = { tagType: v.tagType, mode: v.mode, eventId: v.eventId || undefined, quantity: v.mode === "generate" ? Number(v.quantity) : undefined, uids: v.mode === "import" ? String(v.uids || "").split(/\s+/).filter(Boolean) : undefined };
    const r = await post("/api/admin/tag-batches", body);
    const csv = ["payload,display_code,activation_code,security_level", ...r.tags.map((t) => [t.payload, t.displayCode, t.activationCode, t.securityLevel].join(","))].join("\n");
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `ticketroom-tags-${r.batchId.slice(0, 8)}.csv` });
    a.click(); toast(`${r.tags.length} tags created. The CSV is the only copy of the tokens and activation codes — store it securely.`, "good"); draw();
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
  render(main, html`${head("Support cases")}${tbl(["Ref", "From", "Topic", "Subject", "Status", ""], cases.map((c) => html`<tr><td class="mono">${c.reference}</td><td class="small">${c.email}</td><td>${c.category}</td><td><strong>${c.subject}</strong><div class="small muted">${c.body.slice(0, 160)}</div></td><td>${badge(c.status)}</td>
    <td>${isA() || isS() ? html`<button class="btn btn-ghost btn-sm" data-c="${c.id}">Update</button>` : ""}</td></tr>`))}`);
  $$("[data-c]").forEach((b) => b.addEventListener("click", () => {
    const c = cases.find((x) => x.id === b.dataset.c);
    const dlg = dialog(c.subject, html`<p class="prose small">${c.body}</p><form class="stack"><div class="field"><label for="ss">Status</label><select id="ss" name="status">${["open", "in_progress", "resolved", "closed"].map((s) => html`<option ${raw(s === c.status ? "selected" : "")}>${s}</option>`)}</select></div><div class="field"><label for="sr">Resolution (visible to customer)</label><textarea id="sr" name="resolution">${c.resolution || ""}</textarea></div><button class="btn btn-dark">Save</button></form>`);
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

(async () => {
  await header($("#header"), { portal: "Back office", links: [["/admin", "Back office"]] });
  const u = await requireUser("TicketRoom staff sign in.");
  if (!u) return render(main, empty("Sign in."));
  R = roles(await me(true));
  await header($("#header"), { portal: "Back office", links: [["/admin", "Back office"]] });
  if (!R.size) { render($("#sidenav"), ""); return render(main, html`${head("No access")}<p>This area is for TicketRoom staff.</p>`); }
  nav();
  router([["/", overview], ["/organisers", organisers], ["/events", events], ["/users", users], ["/lookup", lookup], ["/tags", tags], ["/terminals", terminals], ["/support", support],
    ["/refunds", refunds], ["/payouts", payouts], ["/payments", payments], ["/reconciliation", reconciliation], ["/ledger", ledgerPage], ["/audit", audit], ["/outbox", outbox]], () => { location.hash = "#/"; });
})();
