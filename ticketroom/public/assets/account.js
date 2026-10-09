// Attendee portal: tickets wallet, transfers, tags, cashless, refunds, privacy.
import { html, raw, render, $, $$, get, post, patch, put, api, money, moneyExact, fmtDate, fmtTime, fmtDateTime, header, requireUser, me, toast, onSubmit, idem, badge, empty, spinner, dialog, confirmDialog, parseRand, poster, router, gate, matchPasswords } from "/assets/core.js";

const main = $("#main");
const CACHE_KEY = "tr_wallet_v1";
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

const nav = () => render($("#sidenav"), html`
  <div class="sect">Tickets</div><a href="#/tickets">My tickets</a><a href="#/orders">Orders</a><a href="#/transfers">Transfers</a><a href="#/saved">Saved events</a>
  <div class="sect" data-feature="cashless">Cashless</div><a href="#/wallet" data-feature="cashless">Wallets</a><a href="#/tags" data-feature="cashless">Tags & wristbands</a>
  <div class="sect">Account</div><a href="#/refunds">Refunds & support</a><a href="#/payment-methods" data-feature="payments">Payment methods</a><a href="#/settings">Settings & privacy</a>`);

function head(title, sub = "", actions = "") {
  return html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p class="muted">${sub}</p>` : ""}</div><div class="row">${actions}</div></div>`;
}

// ---------------- tickets ----------------
async function cacheWallet(list) {
  try {
    const withQr = await Promise.all(list.filter((t) => t.status === "valid" && new Date(t.ends_at) > new Date()).map(async (t) => {
      const svg = await fetch(`/api/me/tickets/${t.id}/qr.svg`, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : null));
      return { ...t, qrData: svg ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}` : null };
    }));
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), tickets: withQr }));
  } catch { /* storage full or blocked: wallet still works online */ }
}

function ticketCard(t, offline = false) {
  const live = t.status === "valid";
  const qrSrc = offline ? t.qrData : `/api/me/tickets/${t.id}/qr.svg?v=${encodeURIComponent(t.qrPayload || t.status)}`;
  return html`<article class="ticket ${t.status === "used" ? "used" : live ? "" : "void"}" aria-label="Ticket ${t.code}">
    <div><div class="t-head"><span class="cat-label">${t.category}</span><h3 class="mb-0">${t.title}</h3></div>
      <div class="t-main"><dl class="dl"><dt>When</dt><dd>${fmtDate(t.starts_at, { weekday: "long", day: "numeric", month: "long" })} · ${fmtTime(t.starts_at)}</dd>
        <dt>Where</dt><dd>${t.venue_name}, ${t.city}</dd><dt>Ticket</dt><dd>${t.ticket_type}</dd><dt>Holder</dt><dd>${t.holder_name || "—"}</dd><dt>Order</dt><dd class="mono">${t.order_reference}</dd></dl>
        ${t.pending_transfer ? html`<p class="callout warn mt small">Transfer to <strong>${t.pending_transfer.toEmail}</strong> is waiting to be accepted. <a href="#/transfers">Manage</a></p>` : ""}
        ${!offline && live ? html`<div class="row mt no-print">${t.transfers_enabled && !t.pending_transfer && new Date(t.starts_at) > new Date() ? html`<button class="btn btn-ghost btn-sm" data-transfer="${t.id}">Transfer</button>` : ""}
          <button class="btn btn-ghost btn-sm" data-rename="${t.id}" data-name="${t.holder_name || ""}">Change holder name</button><button class="btn btn-ghost btn-sm" data-print>Print</button></div>` : ""}
      </div></div>
    <div class="t-qr">${live && qrSrc ? html`<img src="${qrSrc}" alt="QR code for ticket ${t.code}" width="200" height="200">` : html`<span class="stamp ${t.status === "used" ? "" : "muted"}">${t.status}</span>`}
      <span class="code mono">${t.code}</span>${t.status === "used" ? html`<span class="small muted">Scanned ${fmtDateTime(t.admitted_at)}</span>` : live ? html`<span class="tiny muted center">Show this at the gate. The first scan admits.</span>` : ""}</div>
  </article>`;
}

async function tickets() {
  render(main, html`${head("My tickets", "Your QR code gets you in. Keep it to yourself, because whoever scans it first gets in.")}${spinner()}`);
  let list, offline = false;
  try { list = (await get("/api/me/tickets")).tickets; cacheWallet(list); }
  catch (err) {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!cached || err.status) throw err;
    list = cached.tickets; offline = true;
  }
  const now = new Date();
  const upcoming = list.filter((t) => new Date(t.ends_at) > now && !["refunded", "revoked"].includes(t.status));
  const past = list.filter((t) => !upcoming.includes(t));
  render(main, html`${head("My tickets", "Your QR code gets you in. Keep it to yourself, because the first scan wins.", html`<a class="btn btn-primary" href="/">Find events</a>`)}
    ${offline ? html`<p class="callout warn">You're offline. These are the tickets saved on this phone, and they still scan at the gate.</p>` : ""}
    ${upcoming.length ? html`<div class="stack-lg">${upcoming.map((t) => ticketCard(t, offline))}</div>` : empty("No upcoming tickets yet.", html`<a class="btn btn-primary" href="/">Browse events</a>`)}
    ${past.length ? html`<h2 class="mt-lg">Past & inactive</h2><div class="table-wrap"><table><thead><tr><th>Event</th><th>Date</th><th>Ticket</th><th>Status</th></tr></thead><tbody>
      ${past.map((t) => html`<tr><td>${t.title}</td><td>${fmtDate(t.starts_at)}</td><td class="mono">${t.code}</td><td>${badge(t.status)}</td></tr>`)}</tbody></table></div>` : ""}`);
  $$("[data-print]").forEach((b) => b.addEventListener("click", () => window.print()));
  $$("[data-transfer]").forEach((b) => b.addEventListener("click", () => transferDialog(b.dataset.transfer)));
  $$("[data-rename]").forEach((b) => b.addEventListener("click", () => {
    const d = dialog("Ticket holder", html`<form class="stack"><div class="field"><label for="hn">Name on ticket</label><input id="hn" name="holderName" value="${b.dataset.name}" required maxlength="120"></div><button class="btn btn-dark">Save</button></form>`);
    onSubmit($("form", d), async (v) => { await patch(`/api/me/tickets/${b.dataset.rename}`, v); d.close(); toast("Holder name updated.", "good"); tickets(); });
  }));
}

function transferDialog(id) {
  const d = dialog("Transfer ticket", html`<form class="stack">
    <p class="muted">Send this ticket to someone else. When they accept, they get a new QR code and <strong>your copy stops working</strong>.</p>
    <div class="field"><label for="te">Their email address</label><input id="te" name="toEmail" type="email" required autocomplete="off"></div>
    <button class="btn btn-dark">Send transfer</button></form>`);
  onSubmit($("form", d), async (v) => {
    const r = await post(`/api/me/tickets/${id}/transfer`, v);
    d.close();
    toast("Transfer sent. It stays yours until they accept.", "good");
    if (r.transfer.devClaimToken) console.info("DEV claim link:", `${location.origin}/account#/claim/${r.transfer.devClaimToken}`);
    tickets();
  });
}

// ---------------- orders & transfers ----------------
async function orders() {
  const { orders: list } = await get("/api/me/orders");
  render(main, html`${head("Orders")}${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Event</th><th>Date</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
    ${list.map((o) => html`<tr><td class="mono"><a href="/orders/${o.reference}">${o.reference}</a></td><td>${o.title}</td><td>${fmtDate(o.created_at)}</td><td class="num">${moneyExact(o.total_cents)}${o.refunded_cents ? html`<div class="tiny muted">refunded ${moneyExact(o.refunded_cents)}</div>` : ""}</td><td>${badge(o.status)}</td></tr>`)}
    </tbody></table></div>` : empty("No orders yet.")}`);
}

async function transfers() {
  const { outgoing, incoming, emailVerified } = await get("/api/me/transfers");
  render(main, html`${head("Transfers", "Send tickets to friends. Transfers are free while the organiser allows them.")}
    <section class="card"><h2>Incoming</h2>${!emailVerified ? html`<p class="callout">Confirm your email address to see tickets people have sent you, or open the link in the transfer email. <button class="btn-link" data-resend>Resend confirmation</button></p>` : ""}
      ${incoming.length ? html`<div class="stack">${incoming.map((t) => html`<div class="row between card flat"><div><strong>${t.title}</strong><div class="small muted">From ${t.from_name} · expires ${fmtDate(t.expires_at)}</div></div><button class="btn btn-primary btn-sm" data-accept="${t.id}">Accept</button></div>`)}</div>` : html`<p class="muted mb-0">No transfers waiting for you.</p>`}</section>
    <section class="card mt"><h2>Sent</h2>${outgoing.length ? html`<div class="table-wrap"><table><thead><tr><th>Event</th><th>To</th><th>Sent</th><th>Status</th><th></th></tr></thead><tbody>
      ${outgoing.map((t) => html`<tr><td>${t.title}</td><td>${t.to_email}</td><td>${fmtDate(t.created_at)}</td><td>${badge(t.status)}</td><td>${t.status === "pending" ? html`<button class="btn btn-ghost btn-sm" data-cancel="${t.id}">Cancel</button>` : ""}</td></tr>`)}</tbody></table></div>` : html`<p class="muted mb-0">You haven't sent any tickets.</p>`}</section>`);
  $$("[data-accept]").forEach((b) => b.addEventListener("click", async () => { const r = await post("/api/me/transfers/claim", { transferId: b.dataset.accept }); toast(`Ticket for ${r.eventTitle} is now yours.`, "good"); location.hash = "#/tickets"; }));
  $$("[data-cancel]").forEach((b) => b.addEventListener("click", async () => { await post(`/api/me/transfers/${b.dataset.cancel}/cancel`); toast("Transfer cancelled."); transfers(); }));
  $("[data-resend]")?.addEventListener("click", async () => { await post("/api/auth/verify-email/resend"); toast("Confirmation email sent.", "good"); });
}

async function claim({ token }) {
  render(main, html`${head("Accept ticket")}<div class="card stack"><p>Someone has sent you a ticket. Accept it to add it to your wallet.</p><button class="btn btn-primary" id="acc">Accept ticket</button></div>`);
  $("#acc").addEventListener("click", async () => {
    try { const r = await post("/api/me/transfers/claim", { token }); toast(`Ticket for ${r.eventTitle} added.`, "good"); location.hash = "#/tickets"; }
    catch (err) { toast(err.message, "bad"); }
  });
}

// ---------------- tags ----------------
async function tags() {
  const [{ tags: list }, { tickets: tks }] = await Promise.all([get("/api/me/tags"), get("/api/me/tickets")]);
  const events = [...new Map(tks.filter((t) => ["valid", "used"].includes(t.status) && new Date(t.ends_at) > new Date()).map((t) => [t.event_id, t])).values()];
  render(main, html`${head("Tags & wristbands", "Link an NFC wristband, NFC card or QR tag to pay and enter at cashless events.")}
    <div class="grid-2">
      <section class="card"><h2>Link a tag</h2>
        ${events.length ? html`<form class="stack" id="link">
          <div class="field"><label for="ev">Event</label><select id="ev" name="eventId">${events.map((t) => html`<option value="${t.event_id}">${t.title}, ${fmtDate(t.starts_at)}</option>`)}</select></div>
          <div class="field"><label for="dc">Tag code</label><input id="dc" name="displayCode" required placeholder="ABCD-EFGH" autocomplete="off" class="mono"><span class="hint">Printed on the tag or its card.</span></div>
          <div class="field"><label for="ac">Activation code</label><input id="ac" name="activationCode" required placeholder="6 characters" maxlength="6" autocomplete="off" class="mono"><span class="hint">Under the scratch panel on the card. Keep it private.</span></div>
          <button class="btn btn-dark">Link tag</button></form>` : html`<p class="muted">You need a ticket for an upcoming event before you can link a tag. You can also link at the event's registration desk.</p>`}
      </section>
      <section class="card"><h2>Lost your tag?</h2><p class="muted">Block it straight away. Nobody can pay or enter with it after that, and your balance stays safe on your account. Get a replacement at the registration desk.</p>
        <p class="small mb-0">Your balance is stored on your TicketRoom account, never on the tag itself.</p></section>
    </div>
    <h2 class="mt-lg">Your tags</h2>
    ${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Tag</th><th>Type</th><th>Event</th><th>Status</th><th>Last used</th><th></th></tr></thead><tbody>
      ${list.map((t) => html`<tr><td class="mono">${t.display_code}</td><td>${t.tag_type.replace("_", " ")}</td><td>${t.event_title || "—"}</td><td>${badge(t.status)}</td><td>${t.last_used_at ? fmtDateTime(t.last_used_at) : "—"}</td>
        <td>${t.status === "active" ? html`<button class="btn btn-danger btn-sm" data-lost="${t.id}">Report lost</button>` : ""}</td></tr>`)}</tbody></table></div>` : empty("No tags linked yet.")}`);
  if ($("#link")) onSubmit($("#link"), async (v, f) => { await post("/api/me/tags/link", v); f.reset(); toast("Tag linked and active.", "good"); tags(); });
  $$("[data-lost]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmDialog("Report tag lost?", "The tag is blocked immediately and cannot be unblocked by you. Visit the registration desk for a replacement.", { confirm: "Block tag", danger: true }))) return;
    await post(`/api/me/tags/${b.dataset.lost}/lost`); toast("Tag blocked.", "good"); tags();
  }));
}

// ---------------- cashless wallets ----------------
async function wallets() {
  const { wallets: list } = await get("/api/me/wallets");
  render(main, html`${head("Cashless wallets", "Each cashless event has its own balance. Top up before you go and tap your tag at vendors.")}
    ${list.length ? html`<div class="grid-2">${list.map((w) => html`<a class="balance-card" href="#/wallet/${w.id}"><div class="small">${w.title}</div><div class="amt">${moneyExact(w.balanceCents)}</div><div class="small">${fmtDate(w.starts_at)} · ${new Date(w.ends_at) < new Date() ? "Event ended" : "Tap to top up"}</div></a>`)}</div>`
      : empty("No cashless events yet. When you buy a ticket for a cashless event, its wallet appears here.")}`);
}

async function wallet({ eventId }) {
  const w = await get(`/api/me/wallets/${eventId}`);
  const u = await me();
  const ended = new Date(w.event.endsAt) < new Date();
  render(main, html`<div class="crumbs"><a href="#/wallet">Wallets</a></div>${head(w.event.title, `${fmtDate(w.event.startsAt)}`)}
    <div class="grid-2"><div class="balance-card"><div class="small">Available balance</div><div class="amt">${moneyExact(w.balanceCents)}</div><div class="small">Spend by tapping your linked tag at any vendor.</div></div>
      <section class="card">${ended ? html`<h2>Event finished</h2><p class="muted">Request a refund of any unused balance to the card you topped up with.</p>`
        : html`<h2>Top up</h2><form class="stack" id="tu"><div class="row">${[10000, 20000, 50000].map((c) => html`<button type="button" class="chip" data-amt="${c}">${money(c)}</button>`)}</div>
          <div class="field"><label for="amt">Amount (R)</label><input id="amt" name="amount" inputmode="decimal" required placeholder="e.g. 150"><span class="hint">Between ${money(w.limits.minTopupCents)} and ${money(w.limits.maxTopupCents)}. Max balance ${money(w.limits.maxBalanceCents)}.</span></div>
          <button class="btn btn-primary">Top up</button></form>`}
        ${w.balanceCents > 0 ? html`<button class="btn btn-link" id="rf">Request refund of unused balance</button>` : ""}</section></div>
    ${!u.has_pin ? html`<p class="callout warn mt">Purchases of ${money(w.limits.pinThresholdCents || 20000)} or more need a spending PIN. <a href="#/settings">Set your PIN</a>.</p>` : ""}
    <h2 class="mt-lg">Activity</h2>
    ${w.history.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th>Reference</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
      ${w.history.map((h) => html`<tr><td>${fmtDateTime(h.created_at)}</td><td>${h.kind === "purchase" ? `Purchase · ${h.vendor}` : h.kind === "topup" ? "Top-up" : "Refund"}</td><td class="mono">${h.reference}</td><td>${badge(h.status)}</td><td class="num">${moneyExact(h.amount_cents)}</td></tr>`)}</tbody></table></div>` : empty("No activity yet.")}`);
  $$("[data-amt]").forEach((b) => b.addEventListener("click", () => { $("#amt").value = String(Number(b.dataset.amt) / 100); }));
  if ($("#tu")) onSubmit($("#tu"), async (v) => {
    const cents = parseRand(v.amount);
    if (!cents) throw Object.assign(new Error("Enter an amount in rand."), { details: { amount: "Enter an amount like 150 or 150.50." } });
    const r = await post(`/api/me/wallets/${eventId}/topups`, { amountCents: cents, idempotencyKey: idem() });
    if (r.payment.redirectUrl) location.href = r.payment.redirectUrl;
  });
  $("#rf")?.addEventListener("click", async () => {
    if (!(await confirmDialog("Refund unused balance?", "We'll send your unused balance back to the card(s) you topped up with, once approved. You won't be able to spend it meanwhile.", { confirm: "Request refund" }))) return;
    const r = await post(`/api/me/wallets/${eventId}/refund`); toast(`Refund ${r.refund.reference} requested.`, "good"); wallet({ eventId });
  });
}

// ---------------- refunds & support ----------------
async function refunds() {
  const [{ refunds: rf }, { cases }] = await Promise.all([get("/api/me/refunds"), get("/api/me/support")]);
  render(main, html`${head("Refunds & support", "", html`<a class="btn btn-ghost" href="/help">Contact support</a>`)}
    <section class="card"><h2>Refunds</h2>${rf.length ? html`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Event</th><th>Type</th><th>Requested</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
      ${rf.map((r) => html`<tr><td class="mono">${r.reference}</td><td>${r.title}</td><td>${r.kind.replace("_", " ")}</td><td>${fmtDate(r.created_at)}</td><td>${badge(r.status)}</td><td class="num">${moneyExact(r.amount_cents)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted mb-0">No refunds.</p>`}</section>
    <section class="card mt"><h2>Support cases</h2>${cases.length ? html`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Subject</th><th>Status</th><th>Updated</th></tr></thead><tbody>
      ${cases.map((c) => html`<tr><td class="mono">${c.reference}</td><td>${c.subject}${c.resolution ? html`<div class="small muted">${c.resolution}</div>` : ""}</td><td>${badge(c.status)}</td><td>${fmtDate(c.updated_at)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted mb-0">No support cases.</p>`}</section>`);
}

// ---------------- settings & privacy ----------------
async function settings() {
  const u = await me(true);
  const { consents } = await get("/api/auth/me/consents");
  render(main, html`${head("Settings & privacy")}
    ${!u.email_verified_at ? html`<p class="callout warn">Your email address isn't confirmed yet. <button class="btn-link" data-resend>Resend confirmation email</button></p>` : ""}
    <div class="grid-2">
      <section class="card"><h2>Profile</h2><form class="stack" id="prof">
        <div class="field"><label for="fn">Full name</label><input id="fn" name="fullName" value="${u.full_name}" required></div>
        <div class="field"><label>Email</label><input value="${u.email}" disabled></div>
        <div class="field"><label for="ph">Mobile</label><input id="ph" name="phone" type="tel" value="${u.phone || ""}" placeholder="082 123 4567"></div>
        <button class="btn btn-dark">Save profile</button></form></section>
      <section class="card" data-feature="cashless"><h2>Spending PIN</h2><p class="muted small">Needed for cashless purchases of R200 or more, so a lost wristband can't be used for big spends. ${u.has_pin ? "A PIN is set." : "No PIN set yet."}</p>
        <form class="stack" id="pin"><div class="field"><label for="pn">New PIN (4–6 digits)</label><input id="pn" name="pin" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" required autocomplete="off"></div>
        <div class="field"><label for="pp">Your password</label><input id="pp" name="password" type="password" required autocomplete="current-password"></div><button class="btn btn-dark">${u.has_pin ? "Change PIN" : "Set PIN"}</button></form></section>
      <section class="card"><h2>Password</h2><form class="stack" id="pw">
        <div class="field"><label for="cp">Current password</label><input id="cp" name="currentPassword" type="password" required autocomplete="current-password"></div>
        <div class="field"><label for="np">New password</label><input id="np" name="newPassword" type="password" required minlength="10" autocomplete="new-password"><span class="hint">At least 10 characters.</span></div>
        <div class="field"><label for="np2">Confirm new password</label><input id="np2" name="newPasswordConfirm" type="password" required minlength="10" autocomplete="new-password"></div>
        <button class="btn btn-dark">Change password</button><p class="tiny muted mb-0">Other devices will be signed out.</p></form></section>
      <section class="card"><h2>Marketing preferences</h2>
        ${consents.length ? html`<div class="stack">${consents.map((c) => html`<label class="check"><input type="checkbox" data-consent data-org="${c.organiser_id || ""}" data-ch="${c.channel}" ${raw(c.granted ? "checked" : "")}><span>${c.organiser_name || "TicketRoom"} — ${c.channel === "sms" ? "SMS" : "email"}</span></label>`)}</div>`
          : html`<p class="muted">You haven't opted in to any marketing.</p>`}
        <label class="check mt"><input type="checkbox" data-consent data-org="" data-ch="email" ${raw(consents.some((c) => !c.organiser_id && c.channel === "email" && c.granted) ? "checked" : "")}><span>TicketRoom event news by email</span></label>
        <button class="btn btn-ghost btn-sm mt" id="unall">Unsubscribe from all marketing</button>
        <p class="tiny muted mb-0">Receipts, tickets and important event updates are still sent.</p></section>
    </div>
    <section class="card mt"><h2>Your data (POPIA)</h2><p class="muted">Download everything we hold about you, or delete your account. Financial records are kept for the period the law requires, with your personal details removed.</p>
      <div class="row"><a class="btn btn-ghost" href="/api/auth/me/export" download>Download my data</a><button class="btn btn-danger" id="del">Delete my account</button></div></section>`);
  onSubmit($("#prof"), async (v) => { await patch("/api/auth/me", v); toast("Profile saved.", "good"); });
  onSubmit($("#pin"), async (v, f) => { await post("/api/auth/me/pin", v); f.reset(); toast("Spending PIN saved.", "good"); await me(true); });
  onSubmit($("#pw"), async (v, f) => { await post("/api/auth/me/password", matchPasswords(v, "newPassword", "newPasswordConfirm")); f.reset(); document.querySelector(".pw-nag")?.remove(); toast("Password changed.", "good"); });
  $$("[data-consent]").forEach((c) => c.addEventListener("change", async () => {
    try { await put("/api/auth/me/consents", { organiserId: c.dataset.org || undefined, channel: c.dataset.ch, granted: c.checked }); toast("Preferences saved.", "good"); }
    catch (err) { c.checked = !c.checked; toast(err.message, "bad"); }
  }));
  $("#unall").addEventListener("click", async () => {
    if (!(await confirmDialog("Unsubscribe from all marketing?", "You'll stop receiving marketing emails and SMSes from TicketRoom and every organiser. You can opt in again at any time."))) return;
    await post("/api/auth/me/consents/unsubscribe-all");
    toast("You're unsubscribed from all marketing.", "good");
    settings();
  });
  $("[data-resend]")?.addEventListener("click", async () => { await post("/api/auth/verify-email/resend"); toast("Confirmation email sent.", "good"); });
  $("#del").addEventListener("click", async () => {
    const d = dialog("Delete account", html`<form class="stack"><p>This permanently removes your personal details. You can't undo it.</p><div class="field"><label for="dp">Password</label><input id="dp" name="password" type="password" required></div><button class="btn btn-danger">Delete my account</button></form>`);
    onSubmit($("form", d), async (v) => { await post("/api/auth/me/delete", v); location.href = "/"; });
  });
}

// ---------------- linked payment methods (TitoPay wallet) ----------------
async function paymentMethods() {
  const pm = await get("/api/me/payment-methods");
  const titopay = pm.links.find((l) => l.provider === "titopay");
  render(main, html`${head("Payment methods", "Link a TitoPay wallet to pay for tickets and top-ups in one tap.")}
    <section class="card stack"><h2>TitoPay wallet</h2>
      ${!pm.titopayAvailable ? html`<p class="callout">TitoPay wallet payments are coming soon. Card payments will be available when paid tickets launch.</p>`
        : titopay ? html`<p>Linked to <strong>${titopay.display_handle}</strong> since ${fmtDate(titopay.linked_at)}. Every payment still needs your approval in the TitoPay app.</p>
          <div class="row"><button class="btn btn-danger" data-unlink="${titopay.id}">Unlink wallet</button></div>`
        : html`<p class="muted">We'll send a one-time code to the mobile number on your TitoPay wallet. TicketRoom never sees your TitoPay PIN or password.</p>
          <form class="stack" id="lk"><div class="field"><label for="lk-ph">TitoPay mobile number</label><input id="lk-ph" name="phone" type="tel" required placeholder="082 123 4567" autocomplete="tel"></div><button class="btn btn-dark">Send code</button></form>`}
      ${pm.titopayEnvironment && pm.titopayEnvironment !== "live" ? html`<p class="tiny muted mb-0">Test environment (${pm.titopayEnvironment}). No real money moves.</p>` : ""}
    </section>`);
  $("[data-unlink]")?.addEventListener("click", async (e) => {
    if (!(await confirmDialog("Unlink TitoPay wallet?", "You can link it again at any time.", { confirm: "Unlink", danger: true }))) return;
    await api("DELETE", `/api/me/payment-methods/${e.currentTarget.dataset.unlink}`); toast("Wallet unlinked.", "good"); paymentMethods();
  });
  if ($("#lk")) onSubmit($("#lk"), async (v) => {
    const r = await post("/api/me/payment-methods/titopay/link", v);
    const d = dialog("Enter your TitoPay code", html`<form class="stack"><p>We sent a code to ${r.sentTo}.${r.devOtp ? html` <span class="badge warn">Test code: ${r.devOtp}</span>` : ""}</p>
      <div class="field"><label for="otp">Code</label><input id="otp" name="otp" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" required autocomplete="one-time-code"></div><button class="btn btn-primary btn-block">Link wallet</button></form>`);
    onSubmit($("form", d), async (x) => { await post("/api/me/payment-methods/titopay/confirm", { linkRequestId: r.linkRequestId, otp: x.otp }); d.close(); toast("TitoPay wallet linked.", "good"); paymentMethods(); });
  });
}

// Events this person liked (the heart on an event page).
async function saved() {
  const { events } = await get("/api/me/likes");
  const upcoming = events.filter((e) => new Date(e.ends_at) > new Date());
  render(main, html`<div class="page-head"><div><h1>Saved events</h1><p class="muted">Events you liked. Tap the heart on any event page to add or remove one.</p></div></div>
    ${upcoming.length ? html`<div class="table-wrap"><table><thead><tr><th>Event</th><th>When</th><th>Where</th><th></th></tr></thead><tbody>${upcoming.map((e) => html`<tr>
      <td><a href="/events/${e.slug}"><strong>${e.title}</strong></a></td><td class="small">${fmtDateTime(e.starts_at)}</td><td class="small">${e.venue_name}, ${e.city}</td>
      <td><a class="btn btn-primary btn-sm" href="/events/${e.slug}">${e.remaining === 0 ? "View" : "Get tickets"}</a></td></tr>`)}</tbody></table></div>`
      : empty("Nothing saved yet. Tap the heart on an event you like and it will appear here.", html`<a class="btn btn-primary" href="/">Find events</a>`)}`);
}

async function verify({ token }) {
  try { await post("/api/auth/verify-email", { token }); toast("Email confirmed. Thank you.", "good"); } catch (err) { toast(err.message, "bad"); }
  location.hash = "#/tickets";
}

function reset({ token }) {
  render(main, html`${head("Choose a new password")}<div class="card"><form class="stack" id="rs"><div class="field"><label for="np">New password</label><input id="np" name="password" type="password" minlength="10" required autocomplete="new-password"><span class="hint">At least 10 characters.</span></div><div class="field"><label for="np2">Confirm new password</label><input id="np2" name="passwordConfirm" type="password" minlength="10" required autocomplete="new-password"></div><button class="btn btn-dark">Save password</button></form></div>`);
  onSubmit($("#rs"), async (v) => { matchPasswords(v, "password", "passwordConfirm"); await post("/api/auth/password/reset", { token, password: v.password }); toast("Password changed. Please sign in.", "good"); location.href = "/signin"; });
}

(async () => {
  const pre = location.hash.match(/^#\/reset\/(.+)$/);
  await header($("#header"), { portal: "customer" });
  if (pre) { nav(); return reset({ token: pre[1] }); }
  const u = await requireUser("Sign in to see your tickets.");
  if (!u) return render(main, empty("Sign in to see your tickets."));
  await header($("#header"), { portal: "customer" });
  nav();
  router([
    ["/", tickets], ["/tickets", tickets], ["/saved", saved], ["/orders", orders], ["/transfers", transfers], ["/claim/:token", claim], ["/tags", gate("cashless", tags)],
    ["/wallet", gate("cashless", wallets)], ["/wallet/:eventId", gate("cashless", wallet)], ["/refunds", refunds], ["/payment-methods", gate("payments", paymentMethods)], ["/settings", settings], ["/verify/:token", verify], ["/reset/:token", reset],
  ], () => { location.hash = "#/tickets"; });
})();
void poster;
