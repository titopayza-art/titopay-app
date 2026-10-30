// Attendee portal: tickets wallet, transfers, tags, cashless, refunds, privacy.
import { html, raw, render, $, $$, get, post, patch, put, api, money, moneyExact, plural, fmtDate, fmtTime, fmtDateTime, header, authDialog, me, emailLinkPage, wrongAccountPage, accountType, toast, onSubmit, idem, badge, empty, spinner, dialog, confirmDialog, parseRand, poster, router, gate, matchPasswords, features, ticketPng, calendarFile , phoneVerifyDialog, accountDeletionDialog } from "/assets/core.js?build=2026-10-22-phases";

const main = $("#main");
const CACHE_KEY = "tr_wallet_v1";
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

const nav = () => render($("#sidenav"), html`
  <div class="sect">Tickets</div><a href="#/tickets">My tickets</a><a href="#/orders">Orders</a><a href="#/transfers">Transfers</a><a href="#/waitlists">Waitlists</a><a href="#/resale">Resale</a><a href="#/saved">Saved events</a>
  <div class="sect" data-feature="cashless">Cashless</div><a href="#/wallet" data-feature="cashless">Wallets</a><a href="#/tags" data-feature="cashless">Tags & wristbands</a>
  <div class="sect">Account</div><a href="#/refunds">Refunds & support</a><a href="#/payment-methods" data-feature="payments">Payment methods</a><a href="#/settings">Settings & privacy</a>`);

function head(title, sub = "", actions = "") {
  return html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p class="muted">${sub}</p>` : ""}</div><div class="row">${actions}</div></div>`;
}

// ---------------- tickets ----------------
async function cacheWallet(list) {
  try {
    const withQr = await Promise.all(list.filter((t) => t.status === "valid" && !t.refund_open && new Date(t.ends_at) > new Date()).map(async (t) => {
      const svg = await fetch(`/api/me/tickets/${t.id}/qr.svg`, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : null));
      return { ...t, qrData: svg ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}` : null };
    }));
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), tickets: withQr }));
  } catch { /* storage full or blocked: wallet still works online */ }
}

// The ticket itself follows TicketRoom's ticket design: navy header with the
// event, the details, the QR code, a tear line, then the ticket code. The
// buttons sit under the ticket so it prints and screenshots clean.
function ticketCard(t, offline = false) {
  const live = t.status === "valid";
  const qrSrc = offline ? t.qrData : `/api/me/tickets/${t.id}/qr.svg?v=${encodeURIComponent(t.qrPayload || t.status)}`;
  const place = [t.venue_name, t.city].filter(Boolean).join(", ");
  return html`<div class="tk-wrap"><div class="tk-brand print-only"><img src="/assets/logo-mark-dark.svg" alt="" width="48" height="36"><span class="wordmark">TICKET<b>ROOM</b></span></div><article class="ticket ${t.status === "used" ? "used" : live ? "" : "void"} ${Number(t.test) === 1 ? "is-test" : ""}" aria-label="${Number(t.test) === 1 ? "Test ticket" : "Ticket"} ${t.code}">
    ${Number(t.test) === 1 ? html`<p class="tk-test" role="note">TEST TICKET · not valid for entry</p>` : ""}
    <header class="tk-head"><span class="tk-label">TicketRoom ticket</span><h3>${t.title}</h3>
      <p class="tk-when">${fmtDate(t.starts_at, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, ${fmtTime(t.starts_at)}</p><p class="tk-where">${place}</p></header>
    <div class="tk-body"><dl class="tk-rows"><div><dt>Ticket</dt><dd>${t.ticket_type}</dd></div><div><dt>Holder</dt><dd>${t.holder_name || "Not set"}</dd></div>${t.admits > 1 ? html`<div><dt>Admits</dt><dd>${t.admits} people</dd></div>` : ""}<div><dt>Order</dt><dd class="mono">${t.order_reference}</dd></div></dl>
      <div class="t-qr">${live && qrSrc ? html`<img src="${qrSrc}" alt="QR code for ticket ${t.code}" width="220" height="220">` : html`<span class="stamp ${t.status === "used" ? "" : "muted"}">${t.status}</span>`}</div>
      <p class="tk-scan">${t.status === "used" ? `Scanned ${fmtDateTime(t.admitted_at)}` : live ? "Scan at the entrance" : ""}</p></div>
    <div class="tk-perf" aria-hidden="true"></div>
    <div class="tk-foot"><span class="tk-label">Ticket code</span><span class="tk-code">${t.code}</span>
      <p class="tk-note">Present this ticket at the entrance. Do not share the code publicly.</p></div>
  </article>
  ${t.resale?.listing ? html`<div class="callout small no-print resale-note"><span>Up for resale on TicketRoom Exchange at <strong>${moneyExact(t.resale.listing.priceCents)}</strong>.
    ${t.resale.listing.status === "held" ? (t.resale.listing.withdrawRequested ? "Someone is paying for it right now. If their payment doesn't go through, it comes off the exchange." : "Someone is paying for it right now.") : t.resale.listing.status === "offered" ? "Offered to the next person on the waitlist." : "Still yours until it sells."}</span>
    ${!t.resale.listing.withdrawRequested ? html`<button class="btn btn-ghost btn-sm" data-unlist="${t.resale.listing.id}">Take it off</button>` : ""}</div>` : ""}
  ${t.refund_open ? html`<p class="callout warn small no-print">Refund in progress. This ticket can't be used, passed on or sold while the refund is open.</p>` : ""}
  ${t.pending_transfer ? html`<p class="callout warn small no-print">Transfer to <strong>${t.pending_transfer.toEmail}</strong> is waiting to be accepted. <a href="#/transfers">Manage</a></p>` : ""}
  ${!offline && live ? html`<div class="tk-actions no-print"><div class="row">${t.transfers_enabled && !t.pending_transfer && !t.refund_open && new Date(t.starts_at) > new Date() ? html`<button class="btn btn-ghost btn-sm" data-transfer="${t.id}">Transfer</button>` : ""}
      ${t.resale?.open && t.resale.faceValueCents > 0 && !t.resale.listing && !t.pending_transfer && !t.refund_open ? html`<button class="btn btn-ghost btn-sm" data-sell="${t.id}">Sell</button>` : ""}
      <button class="btn btn-ghost btn-sm" data-rename="${t.id}" data-name="${t.holder_name || ""}">Change holder name</button><button class="btn btn-ghost btn-sm" data-print>Print</button></div>
    <div class="wallet-row" data-wallet="${t.id}" data-code="${t.code}" data-title="${t.title}" data-starts="${t.starts_at}" data-ends="${t.ends_at}" data-place="${place}" data-slug="${t.slug}"
      data-type="${t.ticket_type}" data-holder="${t.holder_name || ""}" data-order="${t.order_reference}" data-admits="${t.admits || 1}" data-test="${Number(t.test) === 1 ? "1" : ""}"></div></div>` : ""}
  </div>`;
}

// Wallet buttons under each ticket, matched to the phone: Apple Wallet on an
// iPhone or iPad, Google Wallet on Android, both on a computer. They show only
// once TicketRoom's wallet accounts are set up. "Save ticket image" always
// works: a picture of the QR code for the phone's photo gallery.
const DEVICE = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "apple"
  : /Android/i.test(navigator.userAgent) ? "google" : "desktop";
async function walletButtons() {
  const f = await features();
  for (const box of $$("[data-wallet]")) {
    const id = box.dataset.wallet;
    const apple = f.walletApple && DEVICE !== "google";
    const google = f.walletGoogle && DEVICE !== "apple";
    render(box, html`${apple ? html`<a class="wallet-btn apple" href="/api/me/tickets/${id}/wallet/apple">${raw('<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18" stroke="currentColor" stroke-width="2"/></svg>')} Add to Apple Wallet</a>` : ""}
      ${google ? html`<button type="button" class="wallet-btn google" data-gw>${raw('<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18" stroke="currentColor" stroke-width="2"/></svg>')} Add to Google Wallet</button>` : ""}
      <button type="button" class="btn btn-ghost btn-sm" data-img>Save ticket image</button><button type="button" class="btn btn-ghost btn-sm" data-cal>Add to calendar</button>`);
    $("[data-cal]", box).addEventListener("click", () => calendarFile({ title: box.dataset.title, starts: box.dataset.starts, ends: box.dataset.ends, place: box.dataset.place, url: `${location.origin}/events/${box.dataset.slug}` }));
    $("[data-gw]", box)?.addEventListener("click", async () => {
      try { location.href = (await get(`/api/me/tickets/${id}/wallet/google`)).url; } catch (err) { toast(err.message, "bad"); }
    });
    $("[data-img]", box).addEventListener("click", async () => {
      try {
        const svg = await fetch(`/api/me/tickets/${id}/qr.svg`, { credentials: "same-origin" }).then((r) => { if (!r.ok) throw new Error("Could not load the ticket."); return r.text(); });
        const d = box.dataset;
        const png = await ticketPng(svg, { test: d.test === "1", title: d.title, when: `${fmtDate(d.starts, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, ${fmtTime(d.starts)}`, place: d.place, code: d.code,
          rows: [["Ticket", d.type], ["Holder", d.holder || "Not set"], ...(Number(d.admits) > 1 ? [["Admits", `${d.admits} people`]] : []), ["Order", d.order]] });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(png); a.download = `ticket-${box.dataset.code}.png`; document.body.append(a); a.click(); a.remove();
        toast("Saved. Show this picture at the gate if you have no signal.", "good");
      } catch (err) { toast(err.message, "bad"); }
    });
  }
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
      ${past.map((t) => html`<tr><td>${t.title}</td><td>${fmtDate(t.starts_at)}</td><td class="mono">${t.code}</td><td>${badge(t.revoked_reason === "resold" ? "resold" : t.status)}</td></tr>`)}</tbody></table></div>` : ""}`);
  $$("[data-print]").forEach((b) => b.addEventListener("click", () => window.print()));
  walletButtons();
  $$("[data-transfer]").forEach((b) => b.addEventListener("click", () => transferDialog(b.dataset.transfer)));
  $$("[data-sell]").forEach((b) => b.addEventListener("click", () => sellDialog(list.find((t) => t.id === b.dataset.sell))));
  $$("[data-unlist]").forEach((b) => b.addEventListener("click", () => unlist(b.dataset.unlist, tickets)));
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

// ---------------- TicketRoom Exchange ----------------
// Selling a ticket: never for more than you paid. The waitlist gets the
// first offer, then fans see it on the event page while it is sold out.
const bankFields = () => html`<fieldset class="stack card flat"><legend class="label">Pay me by EFT into</legend>
  <div class="field"><label for="bh">Account holder</label><input id="bh" name="accountHolder" required autocomplete="name"></div>
  <div class="field"><label for="bn">Bank</label><input id="bn" name="bankName" required placeholder="e.g. FNB"></div>
  <div class="grid-2"><div class="field"><label for="bb">Branch code</label><input id="bb" name="branchCode" required inputmode="numeric"></div><div class="field"><label for="ba">Account number</label><input id="ba" name="accountNumber" required inputmode="numeric" autocomplete="off"></div></div>
  <p class="tiny muted mb-0">Stored encrypted. Only TicketRoom finance sees the full number, to pay you.</p></fieldset>`;
function sellDialog(t) {
  const r = t.resale;
  const d = dialog("Sell on TicketRoom Exchange", html`<form class="stack">
    <p class="mb-0">Can't make it to <strong>${t.title}</strong>? Put your ticket up for resale. People on the waitlist get first offer, then it shows on the event page.</p>
    <div class="field"><label for="rp">Your price (R)</label><input id="rp" name="price" inputmode="decimal" required value="${(r.maxPriceCents / 100).toFixed(2)}">
      <span class="hint">At most ${moneyExact(r.maxPriceCents)}, what you paid. The buyer pays the service fee on top.</span></div>
    ${r.payoutMethod === "card" ? html`<p class="small mb-0">When it sells, the money goes back to the card you paid with. No fee for selling.</p>` : bankFields()}
    <p class="small muted mb-0">The ticket stays yours until it sells, and you can take it off any time before then. When it sells, the buyer gets a new ticket and your QR code stops working. Resale closes when the doors open, ${fmtDateTime(r.closesAt)}.</p>
    <button class="btn btn-primary">Put it up for resale</button></form>`);
  onSubmit($("form", d), async (v) => {
    const cents = parseRand(v.price);
    if (!cents) throw Object.assign(new Error("Enter a price in rand."), { details: { price: "Enter a price like 150 or 150.50." } });
    const bank = r.payoutMethod === "eft" ? { accountHolder: v.accountHolder, bankName: v.bankName, branchCode: v.branchCode, accountNumber: v.accountNumber } : undefined;
    try { await post(`/api/me/tickets/${t.id}/resale`, { priceCents: cents, ...(bank ? { bank } : {}) }); }
    catch (err) { if (err.details?.priceCents) err.details = { price: err.details.priceCents }; throw err; }
    d.close();
    toast("Your ticket is up for resale. We'll email you when it sells.", "good");
    tickets();
  });
}
async function unlist(id, then) {
  if (!(await confirmDialog("Take it off resale?", "Your ticket stays yours and keeps working.", { confirm: "Take it off" }))) return;
  try {
    const r = await post(`/api/me/resale/${id}/cancel`);
    toast(r.listing?.withdrawRequested && r.listing.status === "held" ? "Someone is paying for it right now. If their payment doesn't go through, it comes off the exchange." : "Your ticket is off resale.", "good");
    then();
  } catch (err) { toast(err.message, "bad"); }
}
async function resale() {
  const { listings } = await get("/api/me/resale");
  const st = (l) => l.status === "sold" ? (l.payout?.status === "paid" ? "paid to you" : "sold") : l.status === "active" ? "up for resale" : l.status === "offered" ? "offered to waitlist" : l.status === "held" ? "being paid" : l.status;
  render(main, html`${head("Resale", "Tickets you put up on TicketRoom Exchange. You never get more than you paid, and nobody pays more than face value.")}
    ${listings.length ? html`<div class="table-wrap"><table><thead><tr><th>Event</th><th>Ticket</th><th class="num">Price</th><th>Status</th><th>Paid to you</th><th></th></tr></thead><tbody>
      ${listings.map((l) => html`<tr><td>${l.event.title}<div class="tiny muted mono">${l.reference}</div></td><td>${l.ticketType}${l.test ? html` <span class="badge warn">Test</span>` : ""}</td><td class="num">${moneyExact(l.priceCents)}</td><td>${badge(st(l))}</td>
        <td class="small">${l.payout ? html`${l.payout.method === "card" ? "To your card" : "By EFT"}<div class="tiny muted">${l.payout.status === "paid" ? `Paid ${fmtDate(l.payout.paidAt)}` : "On its way"}</div>` : ""}</td>
        <td>${["active", "offered"].includes(l.status) || (l.status === "held" && !l.withdrawRequested) ? html`<button class="btn btn-ghost btn-sm" data-unlist="${l.id}">Take it off</button>` : ""}</td></tr>`)}</tbody></table></div>`
      : empty("Nothing up for resale. Can't make an event? Open My tickets and tap Sell on the ticket.", html`<a class="btn btn-primary" href="#/tickets">My tickets</a>`)}`);
  $$("[data-unlist]").forEach((b) => b.addEventListener("click", () => unlist(b.dataset.unlist, resale)));
}

// ---------------- waitlists ----------------
async function waitlists() {
  const { waitlists: list } = await get("/api/me/waitlists");
  render(main, html`${head("Waitlists", "Sold-out tickets you're waiting for. When one comes up we email you a link that holds it for you for half an hour.", html`<a class="btn btn-ghost" href="/">Find events</a>`)}
    ${list.length ? html`<div class="stack">${list.map((w) => html`<div class="card flat row between wl-item"><div><a class="saved-title" href="/events/${w.event.slug}">${w.event.title}</a>
        <div class="small muted">${w.ticketType} · ${fmtDateTime(w.event.startsAt)}</div>
        <div class="small">${w.status === "waiting" ? html`Number <strong>${w.position}</strong> in line` : w.status === "offered" ? html`<strong>A ticket is held for you until ${fmtTime(w.offerExpiresAt)}.</strong> Open the link in the email we sent you.` : badge(w.status === "claimed" ? "ticket offered" : w.status)}</div></div>
      ${["waiting", "offered"].includes(w.status) ? html`<button class="btn btn-ghost btn-sm" data-leave="${w.id}">Leave</button>` : ""}</div>`)}</div>`
      : empty("You're not waiting for anything. When an event is sold out, tap Join the waitlist on its page.", html`<a class="btn btn-primary" href="/">Browse events</a>`)}`);
  $$("[data-leave]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmDialog("Leave the waitlist?", "You lose your place in line.", { confirm: "Leave" }))) return;
    try { await post(`/api/me/waitlists/${b.dataset.leave}/leave`); toast("You've left the waitlist.", "good"); waitlists(); } catch (err) { toast(err.message, "bad"); }
  }));
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
      ${list.map((t) => html`<tr><td class="mono">${t.display_code}</td><td>${t.tag_type.replace("_", " ")}</td><td>${t.event_title || "–"}</td><td>${badge(t.status)}</td><td>${t.last_used_at ? fmtDateTime(t.last_used_at) : "–"}</td>
        <td>${t.status === "active" ? html`<button class="btn btn-danger btn-sm" data-lost="${t.id}">Report lost</button>` : ""}</td></tr>`)}</tbody></table></div>` : empty("No tags linked yet.")}`);
  if ($("#link")) onSubmit($("#link"), async (v, f) => { await post("/api/me/tags/link", v); f.reset(); toast("Tag linked and active.", "good"); tags(); });
  $$("[data-lost]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmDialog("Report tag lost?", "The tag is blocked immediately and cannot be unblocked by you. Visit the registration desk for a replacement.", { confirm: "Block tag", danger: true }))) return;
    await post(`/api/me/tags/${b.dataset.lost}/lost`); toast("Tag blocked.", "good"); tags();
  }));
}

// A till-generated QR opens this private, customer-approved wallet checkout.
// Its token stays in the URL fragment and is sent only in authenticated POST
// bodies; the page shows the server's exact basket and total before approval.
async function posQrPay({ token }) {
  if (!/^[A-Za-z0-9_-]{40,48}$/.test(token)) {
    render(main, html`${head("Payment QR", "") }<div class="card pad-lg"><h2>This payment link is not valid</h2><p class="muted">Ask the cashier to create a new QR code.</p></div>`);
    return;
  }
  render(main, html`${head("Review payment", "Check the stall and amount before you approve.")}${spinner()}`);
  let quote;
  try { quote = await post("/api/me/pos-qr-intents/quote", { token }); }
  catch (err) {
    render(main, html`${head("Payment QR", "") }<div class="card pad-lg"><h2>Payment unavailable</h2><p class="muted">${err.message || "This QR may have expired."} Ask the cashier for a new code if needed.</p><a class="btn btn-ghost" href="/account#/tickets">Back to my tickets</a></div>`);
    return;
  }
  const expires = new Date(quote.expiresAt).getTime();
  const hasEnough = quote.balanceCents >= quote.totalCents;
  let attemptKey = idem(), submitting = false, expired = false;
  render(main, html`${head("Review payment", "This payment comes from your TicketRoom cashless wallet.")}
    <section class="card pad-lg pos-pay-review">
      <p class="small muted">${quote.event.title}</p><h2>${quote.vendor.name}</h2>
      <ul class="activity pos-pay-items">${quote.items.map((it) => html`<li><div class="grow"><strong>${it.name}</strong><div class="small muted">${it.quantity} × ${moneyExact(it.unitPriceCents)}</div></div><strong>${moneyExact(it.unitPriceCents * it.quantity)}</strong></li>`)}</ul>
      <div class="row between pos-pay-total"><strong>Total</strong><strong>${moneyExact(quote.totalCents)}</strong></div>
      <div class="row between small"><span>Wallet balance</span><strong>${moneyExact(quote.balanceCents)}</strong></div>
      <div class="callout warn mt" data-topup-tools ${hasEnough ? "hidden" : ""}><p data-topup-copy>${hasEnough ? "" : "Your wallet balance is too low for this purchase."}</p><div class="row"><a class="btn btn-dark btn-sm" href="/account#/wallet/${quote.event.id}" target="_blank" rel="noopener">Top up wallet</a><button type="button" class="btn btn-ghost btn-sm" data-refresh>Refresh balance</button></div></div>
      ${quote.pinRequired && !quote.hasPin ? html`<p class="callout warn mt">This purchase needs a spending PIN. <a href="/account#/settings" target="_blank" rel="noopener">Set your PIN</a>, then scan a new QR from the cashier.</p>` : ""}
      ${quote.pinRequired && quote.hasPin ? html`<div class="field mt"><label for="pos-pay-pin">Spending PIN</label><input id="pos-pay-pin" name="pin" type="password" inputmode="numeric" autocomplete="off" minlength="4" maxlength="6" pattern="[0-9]{4,6}" required><span class="hint">Required for larger purchases. Enter it on your own phone.</span></div>` : ""}
      <p class="small muted mt" data-pay-expiry>QR valid for <strong data-pay-countdown>--:--</strong>. Only approve if you are at this stall.</p>
      <div class="callout warn mt" data-payment-message hidden role="alert"></div>
      <button type="button" class="btn btn-primary btn-block mt" data-approve ${!hasEnough || (quote.pinRequired && !quote.hasPin) ? "disabled" : ""}>Approve payment of ${moneyExact(quote.totalCents)}</button>
    </section>`);
  const expiryText = $(`[data-pay-countdown]`);
  const updateExpiry = () => {
    const left = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
    if (expiryText) expiryText.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (!left && !expired) {
      expired = true;
      const button = $(`[data-approve]`); if (button) button.disabled = true;
      const message = $(`[data-payment-message]`);
      if (message) { message.hidden = false; message.textContent = "This QR has expired. Ask the cashier for a new one."; }
    }
  };
  updateExpiry();
  const clock = setInterval(() => { if (!document.body.contains(expiryText)) return clearInterval(clock); updateExpiry(); }, 1000);
  $(`#pos-pay-pin`)?.addEventListener("input", (e) => e.currentTarget.removeAttribute("aria-invalid"));
  $(`[data-refresh]`)?.addEventListener("click", () => posQrPay({ token }));
  $(`[data-approve]`)?.addEventListener("click", async (e) => {
    if (submitting || expired || Date.now() >= expires) return;
    const pin = $(`#pos-pay-pin`)?.value || undefined;
    if (quote.pinRequired && (!pin || !/^\d{4,6}$/.test(pin))) {
      const pinField = $(`#pos-pay-pin`);
      if (pinField) { pinField.setAttribute("aria-invalid", "true"); pinField.focus(); }
      const message = $(`[data-payment-message]`);
      if (message) { message.hidden = false; message.textContent = "Enter your 4 to 6 digit spending PIN."; }
      return;
    }
    submitting = true;
    const button = e.currentTarget; button.disabled = true; button.textContent = "Confirming…";
    const message = $(`[data-payment-message]`);
    if (message) { message.hidden = true; message.textContent = ""; }
    try {
      const result = await post("/api/me/pos-qr-intents/confirm", { token, idempotencyKey: attemptKey, ...(pin ? { pin } : {}) });
      if (result.status === "confirmed") {
        clearInterval(clock);
        render(main, html`${head("Payment approved", "") }<section class="card pad-lg center"><span class="badge good">APPROVED</span><h2 class="mt">${moneyExact(result.totalCents)}</h2><p class="muted">Paid to ${quote.vendor.name} · ${result.reference}</p><p>Show the cashier this confirmation before collecting your order.</p><a class="btn btn-primary" href="/account#/wallet/${quote.event.id}">View event wallet</a></section>`);
        return;
      }
      if (result.status === "reversed") {
        clearInterval(clock);
        render(main, html`${head("Payment reversed", "") }<section class="card pad-lg center"><span class="badge bad">REVERSED</span><p class="mt">This payment was reversed. Check your wallet activity and speak with the cashier before continuing.</p><a class="btn btn-ghost" href="/account#/wallet/${quote.event.id}">View event wallet</a></section>`);
        return;
      }
      attemptKey = idem();
      const text = result.message || "The payment could not be approved.";
      if (message) { message.hidden = false; message.textContent = text; }
      if (result.declineReason === "insufficient_funds") {
        if (message) message.textContent = `${text} Top up your wallet, refresh the balance and try again before the QR expires.`;
        const tools = $(`[data-topup-tools]`); if (tools) tools.hidden = false;
        const copy = $(`[data-topup-copy]`); if (copy) copy.textContent = "Top up your wallet, then refresh the balance before trying again.";
      }
      if (result.declineReason === "pin_incorrect") { const pinField = $(`#pos-pay-pin`); if (pinField) { pinField.value = ""; pinField.focus(); } }
      button.textContent = `Approve payment of ${moneyExact(quote.totalCents)}`;
      button.disabled = expired || !hasEnough || (quote.pinRequired && !quote.hasPin);
    } catch (err) {
      // Keep the same key after a network error. If the server committed before
      // the response was lost, retrying that key returns the original sale.
      if (message) { message.hidden = false; message.textContent = err.message || "We could not confirm the result. Retry safely; the same request will not charge twice."; }
      button.textContent = "Retry confirmation";
      button.disabled = expired;
    } finally { submitting = false; }
  });
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
      <section class="card">${ended ? html`<h2>Event finished</h2><p class="muted">${w.cashout ? "Cash out what is left below: to your card, your bank account or in cash." : "Request a refund of any unused balance to the card you topped up with."}</p>`
        : html`<h2>Top up</h2><form class="stack" id="tu">
          <div class="chips" role="radiogroup" aria-label="Who is it for?"><button type="button" class="chip" role="radio" data-for="me" aria-pressed="true">For me</button><button type="button" class="chip" role="radio" data-for="friend" aria-pressed="false">For a friend</button></div>
          <div class="field" id="friend" hidden><label for="fe">Your friend's email</label><input id="fe" name="friendEmail" type="email" autocomplete="off"><span class="hint">They need a TicketRoom account. The money goes on their balance for this event.</span></div>
          <div id="invite"></div>
          <div class="row">${[10000, 20000, 50000].map((c) => html`<button type="button" class="chip" data-amt="${c}">${moneyExact(c)}</button>`)}</div>
          <div class="field"><label for="amt">Amount (R)</label><input id="amt" name="amount" inputmode="decimal" required placeholder="e.g. 150"><span class="hint">Between ${moneyExact(w.limits.minTopupCents)} and ${moneyExact(w.limits.maxTopupCents)}. Max balance ${moneyExact(w.limits.maxBalanceCents)}.</span></div>
          <button class="btn btn-primary">Top up</button></form>`}
        ${w.cashout ? "" : w.balanceCents > 0 ? html`<button class="btn btn-link" id="rf">Request refund of unused balance</button>` : ""}</section></div>
    ${w.cashout ? cashoutSection(w) : ""}
    ${!u.has_pin ? html`<p class="callout warn mt">Purchases of ${moneyExact(w.limits.pinThresholdCents || 20000)} or more need a spending PIN. <a href="#/settings">Set your PIN</a>.</p>` : ""}
    <h2 class="mt-lg">Activity</h2>
    ${w.history.length ? html`<ul class="activity card flat">${w.history.map((h) => {
      const out = h.amount_cents < 0;
      if (h.kind === "gift") return html`<li><div class="grow"><strong>Top-up for ${h.vendor}</strong>${h.test ? html` <span class="badge warn">Test</span>` : ""}
        <div class="small muted">${fmtDate(h.created_at, { day: "numeric", month: "short" })}, ${fmtTime(h.created_at)} · <span class="mono">${h.reference}</span> · on their balance</div></div>
        <div class="right"><div class="amt">${moneyExact(h.amount_cents)}</div>${h.status === "confirmed" ? "" : badge(h.status)}</div></li>`;
      const what = h.kind === "purchase" ? h.vendor || "Purchase" : h.kind === "topup" ? (h.vendor ? `Top-up from ${h.vendor}` : "Top-up") : h.kind === "desk_topup" ? `Top-up at the desk (${h.vendor === "cash" ? "cash" : "card"})`
        : h.kind === "cashout" ? (h.vendor === "eft" ? "Cash-out by EFT" : "Cash-out at the venue") : out ? "Refund to your card" : "Purchase refunded";
      return html`<li><div class="grow"><strong>${what}</strong>${h.test ? html` <span class="badge warn">Test</span>` : ""}
        <div class="small muted">${fmtDate(h.created_at, { day: "numeric", month: "short" })}, ${fmtTime(h.created_at)} · <span class="mono">${h.reference}</span></div></div>
        <div class="right"><div class="amt ${out ? "out" : "in"}">${out ? "−" : "+"}${moneyExact(Math.abs(h.amount_cents))}</div>${h.status === "confirmed" ? "" : badge(h.status)}</div></li>`; })}</ul>` : empty("No activity yet.")}`);
  $$("[data-amt]").forEach((b) => b.addEventListener("click", () => { $("#amt").value = String(Number(b.dataset.amt) / 100); }));
  if ($("#tu")) onSubmit($("#tu"), async (v) => {
    const cents = parseRand(v.amount);
    if (!cents) throw Object.assign(new Error("Enter an amount in rand."), { details: { amount: "Enter an amount like 150 or 150.50." } });
    const friend = !$("#friend").hidden;
    if (friend && !v.friendEmail) throw Object.assign(new Error("Add your friend's email."), { details: { friendEmail: "Who should get the money?" } });
    try {
      const r = await post(`/api/me/wallets/${eventId}/topups`, { amountCents: cents, idempotencyKey: idem(), ...(friend ? { friendEmail: v.friendEmail } : {}) });
      if (r.payment.redirectUrl) location.href = r.payment.redirectUrl;
    } catch (err) {
      if (err.code !== "friend_not_found") throw err;
      render($("#invite"), html`<div class="callout warn stack"><p class="mb-0">${err.message}</p><button type="button" class="btn btn-dark btn-sm" data-invite>Send an invite to ${v.friendEmail}</button></div>`);
      $("[data-invite]").addEventListener("click", async () => {
        try { await post(`/api/me/wallets/${eventId}/invite`, { email: v.friendEmail }); render($("#invite"), html`<p class="callout good mb-0">Invite sent. Once they've signed up you can top them up.</p>`); }
        catch (e2) { toast(e2.message, "bad"); }
      });
    }
  });
  $$("[data-for]").forEach((b) => b.addEventListener("click", () => {
    $$("[data-for]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("#friend").hidden = b.dataset.for !== "friend";
    render($("#invite"), "");
    if (b.dataset.for === "friend") $("#fe").focus();
  }));
  $("[data-cashout]")?.addEventListener("click", () => cashoutDialog(w, eventId));
  $$("[data-cocancel]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmDialog("Cancel this cash-out?", "The money goes back on your balance.", { confirm: "Cancel cash-out" }))) return;
    try { await post(`/api/me/cashouts/${b.dataset.cocancel}/cancel`); toast("Cash-out cancelled. The money is back on your balance.", "good"); wallet({ eventId }); } catch (err) { toast(err.message, "bad"); }
  }));
  $("#rf")?.addEventListener("click", async () => {
    if (!(await confirmDialog("Refund unused balance?", "We'll send your unused balance back to the card(s) you topped up with, once approved. You won't be able to spend it meanwhile.", { confirm: "Request refund" }))) return;
    const r = await post(`/api/me/wallets/${eventId}/refund`); toast(`Refund ${r.refund.reference} requested.`, "good"); wallet({ eventId });
  });
}

// Cashing out what is left: back to the card, to a bank account by EFT, or
// as cash at the venue's cash-out desk (shows a code to scan).
function cashoutSection(w) {
  const c = w.cashout;
  return html`<section class="card mt stack cashout-box"><h2 class="mb-0">Cash out</h2>
    ${c.pending.length ? c.pending.map((p) => html`<div class="stack">${p.method === "cash"
      ? html`<p class="mb-0"><strong>${moneyExact(p.amountCents)} in cash at the venue.</strong> Show this code at the cash-out desk.</p><div class="cashout-code mono">${p.code}</div>
        <div class="center cashout-qr"><img src="/api/me/cashouts/${p.reference}/qr.svg" alt="Cash-out code ${p.code}" width="220" height="220"></div>`
      : html`<p class="mb-0"><strong>${moneyExact(p.amountCents)} by EFT</strong> to ${p.bank}. ${p.status === "approved" ? "Approved: finance is paying it." : "Waiting for TicketRoom finance to approve it."}</p>`}
      ${p.feeCents ? html`<p class="small muted mb-0">Cash-out fee ${moneyExact(p.feeCents)}.</p>` : ""}
      ${["requested", "approved_once"].includes(p.status) ? html`<button class="btn btn-ghost btn-sm" data-cocancel="${p.reference}">Cancel this cash-out</button>` : ""}</div>`)
    : !c.open ? html`<p class="muted mb-0">You can cash out what is left once the event is over (or at the venue's cash-out desk near the end).</p>`
    : w.balanceCents > 0 ? html`<p class="mb-0">You have ${moneyExact(w.balanceCents)} left. Choose how you would like it back.</p><button class="btn btn-primary btn-lg" data-cashout>Cash out my balance</button>
      <p class="small muted mb-0">${c.feeCents ? `There is a ${moneyExact(c.feeCents)} fee for EFT and cash.` : "No fees."}${c.refundPolicy ? ` The organiser's refund policy: ${c.refundPolicy}` : ""}</p>`
    : html`<p class="muted mb-0">Nothing left to cash out.</p>`}</section>`;
}
function cashoutDialog(w, eventId) {
  const c = w.cashout;
  let pick = c.card.maxCents ? "card" : "eft";
  const opts = [
    ["card", "Back to my card", c.card.maxCents ? `Up to ${moneyExact(c.card.maxCents)} goes back to the card you topped up with online. No fee.` : "Only money you topped up online by card can go back to a card.", !c.card.maxCents],
    ["eft", "To my bank account (EFT)", `${moneyExact(c.eft.maxCents)}${c.feeCents ? ` after the ${moneyExact(c.feeCents)} fee` : ""}, paid by TicketRoom finance within a few working days.`, !c.eft.maxCents],
    ["cash", "Cash at the venue", c.cash.open ? `${moneyExact(c.cash.maxCents)} in cash at the cash-out desk. You get a code to show there.` : "The venue's cash-out desk is closed.", !c.cash.open || !c.cash.maxCents],
  ];
  const d = dialog("Cash out my balance", html`<div class="stack"><div class="cashout-pick" role="radiogroup">${opts.map(([k, t, s, off]) => html`<button type="button" role="radio" data-pick="${k}" aria-pressed="${pick === k}" ${off ? "disabled" : ""}><strong>${t}</strong><div class="small muted">${s}</div></button>`)}</div>
    <form class="stack" id="cof"><div id="bank"></div><button class="btn btn-primary btn-block btn-lg" id="cogo">Confirm</button></form></div>`);
  const drawBank = () => {
    $$("[data-pick]", d).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pick === pick)));
    render($("#bank", d), pick === "eft" ? html`<div class="field"><label for="bh">Account holder</label><input id="bh" name="accountHolder" required autocomplete="name"></div>
      <div class="field"><label for="bn">Bank</label><input id="bn" name="bankName" required placeholder="e.g. FNB"></div>
      <div class="grid-2"><div class="field"><label for="bb">Branch code</label><input id="bb" name="branchCode" required inputmode="numeric"></div><div class="field"><label for="ba">Account number</label><input id="ba" name="accountNumber" required inputmode="numeric" autocomplete="off"></div></div>
      <p class="tiny muted mb-0">Stored encrypted. Only TicketRoom finance sees the full number, to pay you.</p>` : "");
    $("#cogo", d).textContent = pick === "card" ? `Refund ${moneyExact(c.card.maxCents)} to my card` : pick === "eft" ? `Pay ${moneyExact(c.eft.maxCents)} to my bank account` : `Get a code for ${moneyExact(c.cash.maxCents)} in cash`;
  };
  $$("[data-pick]", d).forEach((b) => b.addEventListener("click", () => { pick = b.dataset.pick; drawBank(); }));
  drawBank();
  onSubmit($("#cof", d), async (v) => {
    const r = await post(`/api/me/wallets/${eventId}/cashout`, pick === "eft" ? { method: "eft", bank: v } : { method: pick });
    d.close();
    toast(pick === "card" ? `Refund ${r.cashout.reference} asked for. Finance approves it, then it goes back to your card.` : pick === "eft" ? `Cash-out ${r.cashout.reference} asked for. We'll email you when it is paid.` : "Show the code at the cash-out desk.", "good");
    wallet({ eventId });
  });
}

// ---------------- refunds & support ----------------
async function refunds() {
  const [{ refunds: rf }, { cases }] = await Promise.all([get("/api/me/refunds"), get("/api/me/support")]);
  render(main, html`${head("Refunds & support", "", html`<a class="btn btn-ghost" href="/help">Contact support</a>`)}
    <section class="card"><h2>Refunds</h2>${rf.length ? html`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Event</th><th>Type</th><th>Requested</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
      ${rf.map((r) => html`<tr><td class="mono">${r.reference}</td><td>${r.title}</td><td>${r.kind.replace("_", " ")}</td><td>${fmtDate(r.created_at)}</td><td>${badge(r.status)}</td><td class="num">${moneyExact(r.amount_cents)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted mb-0">No refunds.</p>`}</section>
    <section class="card mt"><h2>Support cases</h2>${cases.length ? html`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Subject</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>
      ${cases.map((c) => html`<tr><td class="mono">${c.reference}</td><td>${c.subject}${c.resolution ? html`<div class="small muted">${c.resolution}</div>` : ""}</td><td>${badge(c.status)}</td><td>${fmtDate(c.updated_at)}</td><td><button class="btn btn-ghost btn-sm" data-case="${c.reference}">Replies</button></td></tr>`)}</tbody></table></div>` : html`<p class="muted mb-0">No support cases.</p>`}</section>`);
  // The replies you were emailed, from TicketRoom or the event's organiser.
  $$("[data-case]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const { case: c, messages } = await get(`/api/me/support/${encodeURIComponent(b.dataset.case)}`);
      dialog(c.subject, html`<div class="thread"><div class="msg-row customer"><div class="tiny muted">You · ${fmtDateTime(c.created_at)}</div><p class="prose mb-0">${c.body}</p></div>
        ${messages.length ? messages.map((m) => html`<div class="msg-row ${m.from}"><div class="tiny muted">${m.from === "organiser" ? "The organiser" : "TicketRoom"} · ${fmtDateTime(m.created_at)}</div><p class="prose mb-0">${m.body}</p></div>`) : html`<p class="muted mb-0">No reply yet. We answer within 24 to 48 hours on working days.</p>`}</div>`, { wide: true });
    } catch (err) { toast(err.message, "bad"); }
  }));
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
        <div class="field"><label for="ph">Mobile ${u.phone_verified_at ? html`<span class="badge good">Confirmed</span>` : ""}</label><input id="ph" name="phone" type="tel" value="${u.phone || ""}" placeholder="082 123 4567">
          <span class="hint" data-feature="sms">${u.phone_verified_at ? "Confirmed by SMS. Changing it means confirming the new number." : html`Not confirmed yet. <button type="button" class="btn-link" data-phone>Confirm by SMS</button>`}</span></div>
        <button class="btn btn-dark">Save profile</button></form></section>
      <section class="card" data-feature="cashless"><h2>Spending PIN</h2><p class="muted small">Needed for cashless purchases of R200.00 or more, so a lost wristband can't be used for big spends. ${u.has_pin ? "A PIN is set." : "No PIN set yet."}</p>
        <form class="stack" id="pin"><div class="field"><label for="pn">New PIN (4–6 digits)</label><input id="pn" name="pin" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" required autocomplete="off"></div>
        <div class="field"><label for="pp">Your password</label><input id="pp" name="password" type="password" required autocomplete="current-password"></div><button class="btn btn-dark">${u.has_pin ? "Change PIN" : "Set PIN"}</button></form></section>
      <section class="card"><h2>Password</h2><form class="stack" id="pw">
        <div class="field"><label for="cp">Current password</label><input id="cp" name="currentPassword" type="password" required autocomplete="current-password"></div>
        <div class="field"><label for="np">New password</label><input id="np" name="newPassword" type="password" required minlength="14" autocomplete="new-password"><span class="hint">At least 14 characters.</span></div>
        <div class="field"><label for="np2">Confirm new password</label><input id="np2" name="newPasswordConfirm" type="password" required minlength="14" autocomplete="new-password"></div>
        <button class="btn btn-dark">Change password</button><p class="tiny muted mb-0">Other devices will be signed out.</p></form></section>
      <section class="card"><h2>Security</h2><form class="stack" id="login-otp-settings">
        <label class="check"><input type="checkbox" name="enabled" ${raw(u.email_otp_enabled ? "checked" : "")}><span><strong>Require an email code when I sign in</strong><br><span class="tiny muted">After your password or Google sign-in, we’ll email a one-use code to your confirmed account email. Codes expire in 10 minutes. This applies to future sign-ins; current devices stay signed in.</span></span></label>
        ${!u.email_verified_at ? html`<p class="tiny muted mb-0">Confirm your email address before enabling this option.</p>` : ""}
        <div class="field"><label for="otp-current-password">Confirm with your password</label><input id="otp-current-password" name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn btn-dark">Save security setting</button></form></section>
      <section class="card"><h2>Marketing preferences</h2>
        ${consents.length ? html`<div class="stack">${consents.map((c) => html`<label class="check"><input type="checkbox" data-consent data-org="${c.organiser_id || ""}" data-ch="${c.channel}" ${raw(c.granted ? "checked" : "")}><span>${c.organiser_name || "TicketRoom"} by ${c.channel === "sms" ? "SMS" : "email"}</span></label>`)}</div>`
          : html`<p class="muted">You haven't opted in to any marketing.</p>`}
        <label class="check mt"><input type="checkbox" data-consent data-org="" data-ch="email" ${raw(consents.some((c) => !c.organiser_id && c.channel === "email" && c.granted) ? "checked" : "")}><span>TicketRoom event news by email</span></label>
        <button class="btn btn-ghost btn-sm mt" id="unall">Unsubscribe from all marketing</button>
        <p class="tiny muted mb-0">Receipts, tickets and important event updates are still sent.</p></section>
    </div>
    <section class="card mt"><h2>Your data (POPIA)</h2><p class="muted">Download a copy of your data or ask us to review an account deletion. Some ticket, payment and legally required records may need to be retained.</p>
      <div class="row"><a class="btn btn-ghost" href="/api/auth/me/export" download>Download my data</a><button class="btn btn-danger" id="del">Request account deletion</button></div></section>`);
  onSubmit($("#prof"), async (v) => { await patch("/api/auth/me", v); toast("Profile saved.", "good"); });
  onSubmit($("#login-otp-settings"), async (v, f) => { await put("/api/auth/me/email-otp", v); f.elements.password.value = ""; toast(v.enabled ? "Email sign-in codes enabled." : "Email sign-in codes disabled.", "good"); });
  $("[data-phone]")?.addEventListener("click", () => phoneVerifyDialog($("#ph").value.trim() || u.phone, () => settings()));
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
  $("#del").addEventListener("click", () => accountDeletionDialog({ email: u.email }));
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
    ${upcoming.length ? html`<div class="saved-list">${upcoming.map((e) => html`<div class="card saved-item">
      <div><a class="saved-title" href="/events/${e.slug}">${e.title}</a><p class="small muted">${fmtDateTime(e.starts_at)} · ${e.venue_name}, ${e.city}</p></div>
      <a class="btn btn-primary btn-sm" href="/events/${e.slug}">${e.remaining === 0 ? "View" : "Get tickets"}</a></div>`)}</div>`
      : empty("Nothing saved yet. Tap the heart on an event you like and it will appear here.", html`<a class="btn btn-primary" href="/">Find events</a>`)}`);
}

// The link in the confirmation email. Confirming signs the person in, and any
// tickets bought as a guest with this email are already in the account.
// Signed out: a calm welcome instead of a sign-in box over an empty page.
// With no signal, the tickets saved on this phone still open.
function welcome() {
  render($("#sidenav"), "");
  const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
  if (navigator.onLine === false && cached?.tickets?.length) return tickets();
  render(main, html`<section class="welcome card">
    <span class="tk-label">Customer portal</span>
    <h1>Your tickets live here</h1>
    <p class="lead">Sign in to see your tickets, pass one to a friend, or change the name on a ticket. Bought as a guest? Use the exact email address from checkout when you create your account. Once your email is verified and setup is complete, your tickets and order history will appear here. Buying tickets never requires an account.</p>
    <div class="row"><button class="btn btn-primary" data-in>Sign in</button><button class="btn btn-ghost" data-up>Create account</button></div>
    <p class="small muted mb-0">Looking for something to do? <a href="/">Browse events</a></p></section>`);
  const done = () => location.reload();
  $("[data-in]").addEventListener("click", () => authDialog("signin", { onDone: done, portal: "customer" }));
  $("[data-up]").addEventListener("click", () => authDialog("signup", { onDone: done, portal: "customer" }));
}

(async () => {
  // Home-screen icons added before this version open /account. A fresh launch
  // from the icon goes to the home page, like a new icon does.
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let launched = true;
  try { launched = !!sessionStorage.getItem("tr-launched"); sessionStorage.setItem("tr-launched", "1"); } catch { /* storage blocked */ }
  if (standalone && !launched && !location.hash && navigator.onLine !== false) return location.replace("/");
  await header($("#header"), { portal: "customer" });
  // Links from emails work signed out: choose a new password, confirm an email.
  if (emailLinkPage("customer")) return;
  const u = await me();
  if (!u) return welcome();
  // One account, one portal: organisers and staff have their own.
  if (accountType(u) !== "customer") return wrongAccountPage(u, "customer");
  nav();
  router([
    ["/", tickets], ["/tickets", tickets], ["/saved", saved], ["/orders", orders], ["/transfers", transfers], ["/waitlists", waitlists], ["/resale", resale], ["/claim/:token", claim], ["/pos-pay/:token", posQrPay], ["/tags", gate("cashless", tags)],
    ["/wallet", gate("cashless", wallets)], ["/wallet/:eventId", gate("cashless", wallet)], ["/refunds", refunds], ["/payment-methods", gate("payments", paymentMethods)], ["/settings", settings],
  ], () => { location.hash = "#/tickets"; });
})();
void poster;
