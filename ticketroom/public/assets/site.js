import { html, raw, render, $, $$, get, post, money, moneyExact, fmtDate, fmtTime, fmtDateTime, dayNum, monShort, header, footer, poster, requireUser, me, toast, onSubmit, idem, badge, empty, spinner, esc, siteInfo, callbackFields, callbackDialog, hoursText, weekTable } from "/assets/core.js";
import { documents, ORDER, VERSION, EFFECTIVE } from "/assets/legal.js";

const main = $("#main");
const CATS = [["", "All"], ["music", "Music"], ["festival", "Festivals"], ["comedy", "Comedy"], ["sport", "Sport"], ["arts", "Arts & theatre"], ["food", "Food & drink"], ["family", "Family"], ["business", "Business"], ["nightlife", "Nightlife"]];

const datebadge = (d) => html`<div class="datebadge"><b>${dayNum(d)}</b><span>${monShort(d)}</span></div>`;
const fromPrice = (e) => e.from_price_cents === null ? "" : e.from_price_cents === 0 ? html`<span class="price">Free</span>` : html`<span class="price"><small>From </small>${money(e.from_price_cents)}</span>`;

function card(e) {
  return html`<a class="event-card" href="/events/${e.slug}">
    <div class="poster">${poster(e, "fill")}${datebadge(e.starts_at)}${e.remaining === 0 ? html`<span class="badge bad sold-flag">Sold out</span>` : e.remaining < 30 ? html`<span class="badge amber sold-flag">Selling fast</span>` : ""}</div>
    <div class="body"><span class="cat-label">${e.category}</span><h3>${e.title}</h3>
      <span class="muted small">${fmtDate(e.starts_at, { weekday: "short", day: "numeric", month: "short" })} · ${fmtTime(e.starts_at)}</span>
      <span class="muted small">${e.venue_name}, ${e.city}</span>
      <div class="foot">${fromPrice(e)}<span class="small muted">${e.organiser_name}</span></div></div></a>`;
}

// ---------------- home / discovery ----------------
async function home() {
  document.title = "TicketRoom — Your event. Your ticket.";
  const params = new URLSearchParams(location.search);
  const state = { q: params.get("q") || "", category: params.get("category") || "", city: params.get("city") || "", when: params.get("when") || "", free: params.get("free") || "" };
  render(main, html`
    <section class="hero"><div class="wrap">
      <h1>Your event. <b>Your ticket.</b></h1>
      <p class="lead">Concerts, festivals, comedy, sport and more across South Africa. Secure checkout, instant QR tickets, free transfers.</p>
      <form class="search" role="search" id="search"><label class="sr-only" for="q">Search events</label>
        <input id="q" name="q" placeholder="Search events, venues or cities" value="${state.q}" autocomplete="off">
        <label class="sr-only" for="city">City</label><select id="city" name="city"><option value="">All cities</option></select>
        <button class="btn btn-primary">Search</button></form>
      <div class="feature-rail" id="featured" aria-label="Featured events"></div>
    </div></section>
    <section class="section"><div class="wrap">
      <div class="row between"><h2 class="mb-0">Upcoming events</h2>
        <div class="chips" role="group" aria-label="When">${[["", "Any date"], ["weekend", "This weekend"], ["month", "Next 30 days"]].map(([v, l]) => html`<button class="chip" data-when="${v}" aria-pressed="${state.when === v}">${l}</button>`)}<button class="chip" data-free aria-pressed="${state.free === "1"}">Free events</button></div></div>
      <div class="chips mt" role="group" aria-label="Category">${CATS.map(([v, l]) => html`<button class="chip" data-cat="${v}" aria-pressed="${state.category === v}">${l}</button>`)}</div>
      <div class="event-grid mt" id="grid" aria-live="polite">${spinner()}</div>
    </div></section>
    <section class="section hidden" id="ads"><div class="wrap"><div class="row between"><h2 class="mb-0">Featured</h2><a class="small" href="/contact?topic=advertising">Advertise with us</a></div><div class="poster-rail mt" id="ad-rail"></div></div></section>
    <section class="section"><div class="wrap"><div class="promo-band">
      <div><span class="cat-label">For organisers</span><h2>Sell out your next event with TicketRoom</h2>
        <ul><li>Online and QR tickets with live sales analytics</li><li>Gate scanning that blocks duplicates in real time</li><li>Email &amp; SMS marketing to fans who opted in</li><li>Cashless wristbands, vendor POS and transparent payouts</li></ul></div>
      <div class="row"><a class="btn btn-primary" href="/sell">Start selling</a><a class="btn btn-outline-light" href="/organisers">Organiser login</a></div>
    </div></div></section>`);

  const load = async () => {
    const qs = new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString();
    history.replaceState(null, "", qs ? `/?${qs}` : "/");
    const { events, cities } = await get(`/api/public/events?${qs}`);
    const sel = $("#city");
    if (sel.options.length === 1) cities.forEach((c) => { const o = new Option(`${c.city} (${c.n})`, c.city); sel.add(o); });
    sel.value = state.city;
    render($("#grid"), events.length ? html`${events.map(card)}` : empty("No events match. Try another search or category."));
    if (!state.q && !state.category && !state.city && !state.when && !state.free) {
      const feat = events.filter((e) => e.featured).slice(0, 6);
      render($("#featured"), html`${(feat.length ? feat : events.slice(0, 4)).map((e) => html`<a class="feature" href="/events/${e.slug}">${poster(e)}<span class="shade"></span><div class="meta"><span class="badge amber plain">${fmtDate(e.starts_at, { weekday: "short", day: "numeric", month: "short" })}</span><h3>${e.title}</h3><span class="small">${e.venue_name}, ${e.city} · ${e.from_price_cents === 0 ? "Free" : `from ${money(e.from_price_cents)}`}</span></div></a>`)}`);
    } else render($("#featured"), "");
  };
  $("#search").addEventListener("submit", (e) => { e.preventDefault(); state.q = $("#q").value.trim(); state.city = $("#city").value; load(); });
  $$("[data-cat]").forEach((b) => b.addEventListener("click", () => { state.category = b.dataset.cat; $$("[data-cat]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); load(); }));
  $("[data-free]").addEventListener("click", (e) => { state.free = state.free ? "" : "1"; e.currentTarget.setAttribute("aria-pressed", String(!!state.free)); load(); });
  $$("[data-when]").forEach((b) => b.addEventListener("click", () => { state.when = b.dataset.when; $$("[data-when]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); load(); }));
  siteInfo().then((site) => {
    const ads = (site?.posters || []).filter((a) => a.placement !== "event");
    if (!ads.length) return;
    $("#ads").classList.remove("hidden");
    render($("#ad-rail"), html`${ads.map((a) => html`<a class="ad-poster" href="${a.link_url || "#"}" data-ad="${a.id}" ${raw(/^https?:/i.test(a.link_url || "") ? 'target="_blank" rel="noopener sponsored"' : "")}>
      ${a.image_upload_id ? html`<img src="/media/${a.image_upload_id}" alt="${a.title}" loading="lazy">` : ""}<span class="sponsored">Featured</span>
      <div class="meta"><h3>${a.title}</h3>${a.subtitle ? html`<span>${a.subtitle}</span>` : ""}</div></a>`)}`);
    $$("[data-ad]").forEach((a) => a.addEventListener("click", () => { navigator.sendBeacon?.(`/api/site/posters/${a.dataset.ad}/click`) || post(`/api/site/posters/${a.dataset.ad}/click`).catch(() => {}); }));
  });
  await load();
}

// ---------------- event page + checkout ----------------
async function eventPage(slug) {
  const [{ event: e, ticketTypes }, cfg] = await Promise.all([get(`/api/public/events/${encodeURIComponent(slug)}`), get("/api/config")]);
  document.title = `${e.title} — TicketRoom`;
  const ref = new URLSearchParams(location.search).get("ref");
  if (ref) { sessionStorage.setItem(`tr_ref_${slug}`, ref); post(`/api/public/events/${slug}/click`, { ref }).catch(() => {}); }
  const qty = Object.fromEntries(ticketTypes.map((t) => [t.id, 0]));
  const closed = !e.salesOpen;
  render(main, html`
    <section class="event-hero">${poster(e)}<span class="shade"></span><div class="wrap">
      <div class="crumbs"><a href="/">Events</a> › <span class="muted">${e.category}</span></div>
      <span class="cat-label">${e.category}</span><h1>${e.title}</h1>
      ${e.summary ? html`<p class="lead">${e.summary}</p>` : ""}
      <div class="event-facts"><span>📅 ${fmtDate(e.starts_at, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span><span>🕗 ${fmtTime(e.starts_at)} – ${fmtTime(e.ends_at)}</span><span>📍 ${e.venue_name}, ${e.city}</span></div>
      ${e.status === "cancelled" ? html`<p class="callout bad mt"><strong>This event has been cancelled.</strong> Ticket holders are refunded automatically.</p>` : ""}
    </div></section>
    <div class="wrap event-layout">
      <div class="stack-lg">
        <section class="card"><h2>About this event</h2><div class="prose">${e.description || e.summary || ""}</div></section>
        <section class="card"><h2>Venue</h2><p class="mb-0"><strong>${e.venue_name}</strong><br>${e.address ? html`${e.address}<br>` : ""}${e.city}${e.province ? `, ${e.province}` : ""}</p></section>
        ${e.accessibility_info ? html`<section class="card"><h2>Accessibility</h2><p class="prose mb-0">${e.accessibility_info}</p></section>` : ""}
        <section class="card"><h2>Good to know</h2><dl class="dl">
          <dt>Organiser</dt><dd>${e.organiser_name}</dd>
          ${e.age_restriction ? html`<dt>Age</dt><dd>${e.age_restriction}</dd>` : ""}
          <dt>Transfers</dt><dd>${e.transfers_enabled ? "Free ticket transfers until the event starts" : "Tickets are not transferable"}</dd>
          ${e.cashless_enabled ? html`<dt>Cashless</dt><dd>This is a cashless event. Link a wristband and top up in your account.</dd>` : ""}
          <dt>Refunds</dt><dd>${e.refund_policy}</dd></dl></section>
      </div>
      <aside class="card ticket-box" id="box" aria-labelledby="tix-h"></aside>
    </div>`);

  const box = $("#box");
  const selection = () => ticketTypes.filter((t) => qty[t.id] > 0).map((t) => ({ ticketTypeId: t.id, quantity: qty[t.id] }));
  const drawSelect = () => {
    const count = Object.values(qty).reduce((a, b) => a + b, 0);
    const sub = ticketTypes.reduce((s, t) => s + t.price_cents * qty[t.id], 0);
    const fee = ticketTypes.reduce((s, t) => s + t.fee_cents * qty[t.id], 0);
    render(box, html`<h2 id="tix-h">Tickets</h2>
      ${closed ? html`<p class="callout warn">${e.status === "cancelled" ? "Sales are closed." : "Ticket sales are not open right now."}</p>` : ""}
      ${ticketTypes.length ? ticketTypes.map((t) => html`<div class="tt"><div class="info"><div class="name">${t.name}</div>
          <div class="meta">${t.price_cents === 0 ? "Free" : html`${moneyExact(t.price_cents)} <span>+ ${moneyExact(t.fee_cents)} booking fee</span>`}${t.remaining === 0 ? " · Sold out" : t.remaining < 25 ? ` · Only ${t.remaining} left` : ""}</div>
          ${t.description ? html`<div class="meta">${t.description}</div>` : ""}</div>
        <div class="stepper" role="group" aria-label="${t.name} quantity"><button data-dec="${t.id}" aria-label="Fewer ${t.name}" ${raw(qty[t.id] === 0 ? "disabled" : "")}>−</button><output aria-live="polite">${qty[t.id]}</output><button data-inc="${t.id}" aria-label="More ${t.name}" ${raw(closed || qty[t.id] >= Math.min(t.per_order_limit, t.remaining) ? "disabled" : "")}>+</button></div></div>`) : html`<p class="muted">No tickets available.</p>`}
      <div class="totals"><div class="line"><span>${count} ticket${count === 1 ? "" : "s"}</span><span>${moneyExact(sub)}</span></div>
        <div class="line"><span>Booking fee</span><span>${moneyExact(fee)}</span></div>
        <div class="line total"><span>Total</span><span>${moneyExact(sub + fee)}</span></div></div>
      ${!cfg.cardPaymentsEnabled && sub > 0 ? html`<p class="callout warn mt">Paid tickets go on sale soon. Free tickets are available now.</p>` : ""}
      <button class="btn btn-primary btn-block mt" data-continue ${raw(count === 0 || closed || (!cfg.cardPaymentsEnabled && sub > 0) ? "disabled" : "")}>Continue</button>
      <p class="trust mt mb-0"><span aria-hidden="true">🔒</span> All-in pricing: ${e.is_free ? "this event is free — just register." : "a R10 booking fee per paid ticket, nothing else. Promo codes on the next step."}</p>`);
    $$("[data-inc]", box).forEach((b) => b.addEventListener("click", () => { qty[b.dataset.inc]++; drawSelect(); $(`[data-inc="${b.dataset.inc}"]`, box)?.focus(); }));
    $$("[data-dec]", box).forEach((b) => b.addEventListener("click", () => { qty[b.dataset.dec]--; drawSelect(); $(`[data-dec="${b.dataset.dec}"]`, box)?.focus(); }));
    $("[data-continue]", box).addEventListener("click", async () => {
      const u = await requireUser("Sign in or create a free account to buy tickets. Your tickets live in your account so you can view and transfer them.");
      if (u) { header($("#header")); drawCheckout(u); }
    });
  };

  const drawCheckout = async (u, promo = "") => {
    let pm = { links: [], titopayAvailable: false };
    try { pm = await get("/api/me/payment-methods"); } catch { /* card only */ }
    const titopay = pm.links.find((l) => l.provider === "titopay");
    let quote;
    try { quote = (await post("/api/public/checkout/quote", { eventSlug: slug, items: selection(), promoCode: promo || undefined })).quote; }
    catch (err) { if (promo) { toast(err.message, "bad"); return drawCheckout(u, ""); } throw err; }
    const key = sessionStorage.getItem(`tr_idem_${slug}`) || idem();
    sessionStorage.setItem(`tr_idem_${slug}`, key);
    render(box, html`<div class="steps"><span>Tickets</span><span aria-current="step">Checkout</span><span>Payment</span></div>
      <h2 id="tix-h">Checkout</h2>
      <div class="totals">${quote.lines.map((l) => html`<div class="line"><span>${l.quantity} × ${l.name}</span><span>${moneyExact(l.unitPriceCents * l.quantity)}</span></div>`)}</div>
      <div class="totals"><div class="line"><span>Subtotal</span><span>${moneyExact(quote.subtotalCents)}</span></div>
        ${quote.discountCents ? html`<div class="line"><span>Promo ${quote.promoCode}</span><span>−${moneyExact(quote.discountCents)}</span></div>` : ""}
        <div class="line"><span>Booking fee</span><span>${moneyExact(quote.feeCents)}</span></div>
        <div class="line total"><span>Total</span><span>${moneyExact(quote.totalCents)}</span></div></div>
      <form class="row mt" id="promo"><label class="sr-only" for="pc">Promo code</label><input id="pc" name="code" placeholder="Promo code" class="grow" value="${quote.promoCode || ""}" maxlength="40"><button class="btn btn-ghost btn-sm">Apply</button></form>
      <form class="stack mt" id="pay">
        <p class="small mb-0">Tickets go to <strong>${u.email}</strong>.</p>
        <div class="field"><label for="ph">Mobile number <span class="muted">(optional)</span></label><input id="ph" name="buyerPhone" type="tel" value="${u.phone || ""}" placeholder="082 123 4567"></div>
        ${quote.totalCents > 0 ? html`<fieldset class="stack card flat"><legend class="label">Pay with</legend>
          <label class="check"><input type="radio" name="paymentMethod" value="card" checked><span>Card, EFT or instant EFT</span></label>
          ${pm.titopayAvailable ? (titopay ? html`<label class="check"><input type="radio" name="paymentMethod" value="titopay_wallet"><span>TitoPay wallet <span class="muted small">${titopay.display_handle}</span></span></label>`
            : html`<p class="small mb-0">Have a TitoPay wallet? <a href="/account#/payment-methods">Link it</a> to pay in one tap.</p>`) : ""}</fieldset>` : ""}
        <fieldset class="stack card flat"><legend class="label">Hear from ${e.organiser_name}? <span class="muted">(optional)</span></legend>
          <label class="check"><input type="checkbox" name="mEmail"><span>Email me about their future events</span></label>
          <label class="check"><input type="checkbox" name="mSms"><span>SMS me about their future events</span></label>
          <span class="tiny muted">Unsubscribe any time. We never sell your details.</span></fieldset>
        <button class="btn btn-primary btn-block" type="submit">${quote.totalCents === 0 ? "Get free tickets" : `Pay ${moneyExact(quote.totalCents)}`}</button>
        <button class="btn btn-link btn-block" type="button" data-back>Change tickets</button>
        <p class="tiny muted mb-0">By paying you agree to the <a href="/legal/terms">Terms</a> and the event's refund policy. Your tickets are reserved for a few minutes while you pay. Payment is confirmed by the payment provider, not by your browser.</p>
      </form>`);
    $("#promo").addEventListener("submit", (ev) => { ev.preventDefault(); drawCheckout(u, $("#pc").value.trim()); });
    $("[data-back]", box).addEventListener("click", drawSelect);
    onSubmit($("#pay"), async (v) => {
      const res = await post("/api/public/orders", {
        eventSlug: slug, items: selection(), promoCode: quote.promoCode || undefined, ref: sessionStorage.getItem(`tr_ref_${slug}`) || undefined,
        buyerPhone: v.buyerPhone, marketingOptIn: { email: !!v.mEmail, sms: !!v.mSms }, idempotencyKey: key, paymentMethod: v.paymentMethod || "card",
      });
      sessionStorage.removeItem(`tr_idem_${slug}`);
      if (res.payment?.redirectUrl && res.order.status === "pending_payment") location.href = res.payment.redirectUrl;
      else location.href = `/orders/${res.order.reference}`;
    });
  };
  drawSelect();
}

// ---------------- order status ----------------
async function orderPage(ref) {
  const u = await requireUser("Sign in to view your order.");
  if (!u) return;
  let tries = 0;
  const draw = async () => {
    const { order: o, items, tickets, payment } = await get(`/api/public/orders/${encodeURIComponent(ref)}`);
    const wallet = payment?.method === "titopay_wallet";
    document.title = `Order ${o.reference} — TicketRoom`;
    const pending = o.status === "pending_payment";
    render(main, html`<div class="wrap section"><div class="card pad-lg stack" aria-live="polite">
      <div class="row between"><span class="muted small">Order ${o.reference}</span>${badge(o.status)}</div>
      ${o.status === "paid" ? html`<h1>You're going! 🎉</h1><p>Your ${tickets.length} ticket${tickets.length === 1 ? " is" : "s are"} ready for <strong>${o.event.title}</strong>. We've also emailed a confirmation.</p>
          <div class="row"><a class="btn btn-primary" href="/account#/tickets">View my tickets</a><a class="btn btn-ghost" href="/events/${o.event.slug}">Back to event</a></div>`
        : pending && wallet && payment.status === "failed" ? html`<h1>Payment not approved</h1><p>The TitoPay wallet payment was declined or not approved in time. Nothing was charged.</p><div class="row"><button class="btn btn-primary" data-repay>Try again</button><button class="btn btn-ghost" data-cancel>Cancel order</button></div>`
        : pending && wallet ? html`<h1>Approve in your TitoPay app</h1><p>We've sent a payment request of <strong>${moneyExact(o.totalCents)}</strong> to your TitoPay wallet. Open the TitoPay app and approve it — this page updates by itself.</p>${spinner()}`
        : pending ? html`<h1>Confirming your payment…</h1><p>We're waiting for the payment provider to confirm. This usually takes a few seconds. Please don't pay again.</p>${tries > 20 ? html`<p class="callout warn">Still waiting. If you completed payment, your tickets will appear in your account as soon as the provider confirms. <button class="btn-link" data-repay>Return to payment</button> · <button class="btn-link" data-cancel>Cancel order</button></p>` : spinner()}`
        : o.status === "paid_unfulfilled" ? html`<h1>Payment received — tickets unavailable</h1><p class="callout warn">Your payment arrived after your reservation expired and the tickets had sold out. A full refund has been started automatically.</p>`
        : html`<h1>${o.status === "expired" ? "Reservation expired" : o.status === "cancelled" ? "Order cancelled" : "Order " + o.status.replace(/_/g, " ")}</h1><p>No tickets were issued${o.status === "expired" || o.status === "cancelled" ? " and nothing was charged" : ""}.</p><a class="btn btn-primary" href="/events/${o.event.slug}">Try again</a>`}
      <div class="card flat"><h3>${o.event.title}</h3><p class="muted small mb-0">${fmtDateTime(o.event.startsAt)} · ${o.event.venue}, ${o.event.city}</p>
        <div class="totals">${items.map((i) => html`<div class="line"><span>${i.quantity} × ${i.name}</span><span>${moneyExact(i.unit_price_cents * i.quantity)}</span></div>`)}
        ${o.discountCents ? html`<div class="line"><span>Discount</span><span>−${moneyExact(o.discountCents)}</span></div>` : ""}
        <div class="line"><span>Booking fee</span><span>${moneyExact(o.feeCents)}</span></div><div class="line total"><span>Total</span><span>${moneyExact(o.totalCents)}</span></div></div></div>
    </div></div>`);
    $("[data-repay]")?.addEventListener("click", async () => { try { const r = await post(`/api/public/orders/${ref}/pay`); if (r.payment.redirectUrl) location.href = r.payment.redirectUrl; else { tries = 0; draw(); } } catch (err) { toast(err.message, "bad"); } });
    $("[data-cancel]")?.addEventListener("click", async () => { await post(`/api/public/orders/${ref}/cancel`); draw(); });
    if (pending && !(wallet && payment.status === "failed") && tries++ < 120) setTimeout(draw, tries < 10 ? 1500 : 4000);
  };
  await draw();
}

// ---------------- organisers landing ----------------
function sellPage() {
  document.title = "Sell tickets with TicketRoom";
  const tile = (icon, t, s) => html`<div class="card flat center"><div aria-hidden="true">${raw(icon)}</div><h3 class="mt">${t}</h3><p class="muted mb-0">${s}</p></div>`;
  const ic = (d) => `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#0B1D3F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  render(main, html`<section class="hero"><div class="wrap"><span class="cat-label">For organisers</span><h1>Run your whole event on <b>TicketRoom</b></h1>
      <p class="lead">From the first ticket sold to the last vendor payout — one platform, built in South Africa.</p>
      <div class="row"><button class="btn btn-primary" data-apply>Create an organiser account</button><a class="btn btn-outline-light" href="/organisers">Organiser login</a></div></div></section>
    <section class="section"><div class="wrap stack-lg">
      <div class="grid-2">
        ${tile(ic('<path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6Z"/><path d="M12 9v1M12 14v1"/>'), "Ticket sales", "Online and QR tickets, early-bird releases, promo codes and free events.")}
        ${tile(ic('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'), "Event management", "Listings, ticket types, capacity, staff and vendors in one place.")}
        ${tile(ic('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M7 12h10"/>'), "Entry management", "Phone-based QR scanning with instant duplicate detection and live check-in counts.")}
        ${tile(ic('<path d="M3 20h18M6 16v-3M10 16V9M14 16v-5M18 16V6M4 11l5-5 4 3 7-6"/>'), "Organiser tools", "Sales analytics, email & SMS marketing, attendee lists, settlements and payouts.")}
      </div>
      <div class="card"><h2>What's included</h2><div class="grid-2">
        <ul><li>Real-time sales dashboard and daily trend</li><li>Tracking links to see which channel sells</li><li>Email and SMS campaigns to fans who opted in (POPIA-aligned)</li><li>Free ticket transfers that invalidate the old QR</li></ul>
        <ul><li>RFID/NFC wristbands and QR tags for cashless events</li><li>Vendor POS on any phone, with per-vendor reporting</li><li>Refunds with dual approval and a full audit trail</li><li>Transparent settlements once your event has run</li></ul></div>
      </div>
      <div class="card" id="pricing"><h2>Simple pricing</h2><div class="grid-3">
        <div><div class="kpi"><div class="k">You pay</div><div class="v">5%</div><div class="s">of ticket sales, deducted from your payout</div></div></div>
        <div><div class="kpi"><div class="k">Your buyers pay</div><div class="v">R10</div><div class="s">booking fee per paid ticket</div></div></div>
        <div><div class="kpi"><div class="k">Free events</div><div class="v">R0</div><div class="s">no fees at all — set up a free event in minutes</div></div></div></div>
        <p class="callout mt">Right now TicketRoom is open for <strong>free event listings</strong>. Paid ticket sales are coming soon — set up your event today and switch on paid tickets when they launch.</p>
        <p class="muted small mt mb-0">Example: 100 tickets at R150 = R15 000 in sales. You receive R14 250; each buyer pays R160. Payouts are released after your event, less approved refunds.</p></div>
    </div></section>`);
  $("[data-apply]").addEventListener("click", async () => { const u = await requireUser("Create a free account first, then set up your organiser profile."); if (u) location.href = "/organisers#/apply"; });
}

// ---------------- legal ----------------
// Small markup: blank line = paragraph, "- " = bullet, **bold**. Text is escaped first.
function markup(text) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const out = [];
  let para = [], list = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    para = []; list = [];
  };
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t) { flush(); continue; }
    if (t.startsWith("- ")) { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } list.push(t.slice(2)); }
    else { if (list.length) flush(); para.push(t); }
  }
  flush();
  return raw(out.join(""));
}

async function legal(doc) {
  const site = (await siteInfo()) || { legal: {}, support: { email: "hello@ticketroom.co.za" } };
  const docs = documents(site.legal || {}, site.support || {});
  const d = docs[doc];
  if (!d) return render(main, html`<div class="wrap section"><div class="card pad-lg"><h1>Page not found</h1><p>Choose a document:</p><ul>${ORDER.map(([k, t]) => html`<li><a href="/legal/${k}">${t}</a></li>`)}</ul></div></div>`);
  document.title = `${d.title} — TicketRoom`;
  const slug = (i) => `s${i + 1}`;
  render(main, html`<div class="wrap section"><div class="legal-layout">
    <nav class="legal-nav card" aria-label="Legal documents"><h2 class="h4">Legal</h2><ul>${ORDER.map(([k, t]) => html`<li><a href="/legal/${k}" ${raw(k === doc ? 'aria-current="page"' : "")}>${t}</a></li>`)}</ul>
      <p class="tiny muted mt mb-0">Questions? <a href="mailto:${site.support.email}">${site.support.email}</a></p></nav>
    <article class="card pad-lg legal-doc stack">
      <header><h1>${d.title}</h1><p class="legal-meta mb-0">Version ${VERSION} · Effective ${EFFECTIVE}</p></header>
      <p class="lead">${d.summary}</p>
      ${d.important.length ? html`<aside class="legal-important" aria-labelledby="imp-h"><h2 id="imp-h">Important clauses — please read</h2><ul>${d.important.map((x) => html`<li>${markup(x)}</li>`)}</ul></aside>` : ""}
      ${d.sections.length > 3 ? html`<nav class="legal-toc" aria-label="Contents"><h2>Contents</h2><ol>${d.sections.map(([h], i) => html`<li><a href="#${slug(i)}">${h.replace(/^\d+\.\s*/, "")}</a></li>`)}</ol></nav>` : ""}
      ${d.sections.map(([h, body], i) => html`<section><h2 id="${slug(i)}">${h}</h2>${markup(body)}</section>`)}
      <footer class="legal-meta"><p class="mb-0">${site.legal?.entityName || "TicketRoom"} · ticketroom.co.za · <a href="mailto:${site.support.email}">${site.support.email}</a></p></footer>
    </article></div></div>`);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

// ---------------- help and contact ----------------
const FAQ = [
  ["Where are my tickets?", "Sign in and open My tickets. Each ticket has its own QR code. Add the page to your home screen so it opens even with poor signal."],
  ["Can I send a ticket to a friend?", "Yes, if the organiser allows transfers. Open the ticket, choose Transfer and enter their email. Once they accept, your copy stops working."],
  ["I paid but have no tickets", "Payment is confirmed by the payment provider, which can take a minute. If nothing shows after 15 minutes, request a callback with your order reference — please don't pay again."],
  ["Can I list my event on TicketRoom?", "Yes. We're currently open for free event listings — create an organiser account, add your event and submit it for review. Once approved it is published automatically. Paid tickets are coming soon."],
  ["What does it cost?", "Free events cost nothing. For paid events, buyers pay a R10 booking fee per paid ticket and organisers pay 5% of ticket sales, deducted from their payout."],
  ["How do refunds work?", "If an event is cancelled you are refunded automatically. Other refunds follow the event's refund policy and our Terms and Conditions."],
  ["How do cashless wristbands work?", "Link your wristband in your account with the code and activation code on its card, then top up. Vendors scan it to charge. Lost it? Block it instantly from your account."],
  ["How do I stop marketing messages?", "Use the unsubscribe link in any message, switch off marketing in your account, or use the Unsubscribe page to get a one-click link by email."],
];

async function supportPanel(site, { topic = "callback" } = {}) {
  const u = await me();
  const resp = site?.support?.responseTime || "24–48 hours";
  return html`<div class="grid-2">
    <section class="card stack"><h2>Request a callback</h2>
      <p class="muted mb-0">Fill in the form and our team will resolve your query within <strong>${resp}</strong>.</p>
      <form class="stack" id="cbf" novalidate>${callbackFields(u, topic)}<button class="btn btn-primary">Request callback</button>
        <p class="tiny muted mb-0">We use these details only to respond to you. See our <a href="/legal/privacy">Privacy Policy</a>.</p></form></section>
    <section class="card stack"><h2>Contact us</h2>
      ${site ? html`<p class="callout ${site.hours.openNow ? "good" : "warn"} mb-0"><strong>${hoursText(site.hours)}.</strong></p>` : ""}
      <p class="mb-0">Email <a href="mailto:${site?.support?.email || "hello@ticketroom.co.za"}">${site?.support?.email || "hello@ticketroom.co.za"}</a></p>
      <h3>Office hours</h3>${site ? weekTable(site.hours) : html`<p>Monday to Friday, 9am to 5pm. Closed on weekends and public holidays.</p>`}
      ${site?.hours.upcomingHolidays?.length ? html`<p class="small muted mb-0">Upcoming closures: ${site.hours.upcomingHolidays.map((h) => `${fmtDate(h.date + "T12:00:00+02:00", { day: "numeric", month: "short" })} (${h.name})`).join(", ")}</p>` : ""}
      <p class="small muted mb-0">Requests received after hours, on weekends or public holidays are handled on the next working day.</p>
      ${site?.chatbot?.enabled ? html`<button class="btn btn-ghost" data-open-chat>Ask the assistant now</button>` : ""}</section></div>`;
}

function wireSupport(root) {
  const f = $("#cbf", root);
  if (f) onSubmit(f, async (v) => {
    const r = await post("/api/site/callback", { ...v, source: "web" });
    render(f, html`<div class="callout good"><strong>Thanks — we've got it.</strong> Your reference is <strong>${r.reference}</strong>. We'll contact you within ${r.responseTime}. A confirmation is on its way to your email.</div>`);
  });
  $("[data-open-chat]", root)?.addEventListener("click", () => window.dispatchEvent(new CustomEvent("tr:chat")));
}

async function help() {
  document.title = "Help — TicketRoom";
  const site = await siteInfo();
  render(main, html`<div class="wrap section stack-lg"><div><h1>Help centre</h1><p class="lead mb-0">Quick answers, a smart assistant, and real people when you need them.</p></div>
    <div class="card">${FAQ.map(([q, a]) => html`<details class="tt"><summary class="name">${q}</summary><p class="muted mt">${a}</p></details>`)}</div>
    <div id="sup">${await supportPanel(site)}</div></div>`);
  wireSupport(main);
}

async function contact() {
  document.title = "Contact us — TicketRoom";
  const site = await siteInfo();
  const topic = new URLSearchParams(location.search).get("topic") || "callback";
  render(main, html`<div class="wrap section stack-lg"><div><h1>Contact TicketRoom</h1><p class="lead mb-0">Request a callback and we'll resolve your query within ${site?.support?.responseTime || "24–48 hours"}.</p></div>
    ${await supportPanel(site, { topic })}</div>`);
  wireSupport(main);
}

// ---------------- unsubscribe ----------------
function unsubscribe() {
  document.title = "Unsubscribe — TicketRoom";
  const token = new URLSearchParams(location.search).get("t");
  if (!token) {
    render(main, html`<div class="wrap section"><div class="card pad-lg stack"><h1>Unsubscribe from marketing</h1>
      <p>Enter your email and we'll send you a one-click link to stop <strong>all</strong> marketing emails and SMSes from TicketRoom and every organiser.</p>
      <form class="stack" id="ur"><div class="field"><label for="u-email">Email</label><input id="u-email" name="email" type="email" required autocomplete="email"></div><button class="btn btn-dark">Send unsubscribe link</button></form>
      <p class="small muted mb-0">Signed in? You can also switch marketing off in <a href="/account#/settings">Account → Settings &amp; privacy</a>. Messages about tickets you bought (receipts, event changes) are still sent.</p></div></div>`);
    me().then((u) => { if (u) $("#u-email").value = u.email; });
    onSubmit($("#ur"), async (v, f) => { const r = await post("/api/site/unsubscribe-request", v); render(f, html`<p class="callout good mb-0">${r.message}</p>`); });
    return;
  }
  render(main, html`<div class="wrap section"><div class="card pad-lg stack"><h1>Unsubscribe</h1><p>Stop receiving these marketing messages?</p><button class="btn btn-dark" id="un">Unsubscribe</button><p class="small muted">Transactional messages about tickets you buy (receipts, event changes) will still be sent.</p></div></div>`);
  $("#un").addEventListener("click", async () => {
    try {
      const r = await post("/api/public/unsubscribe", { token });
      render($(".card", main), html`<h1>You're unsubscribed</h1><p>${r.all ? "You won't receive any marketing emails or SMSes from TicketRoom or its organisers any more." : `You won't receive ${r.channel === "sms" ? "SMS" : "email"} marketing from ${r.organiser} any more.`}</p><p class="small muted">Changed your mind? Opt in again any time from your account.</p><a href="/" class="btn btn-ghost">Back to events</a>`);
    } catch (err) { toast(err.message, "bad"); }
  });
}

// ---------------- boot ----------------
(async () => {
  const ALIAS = { "/privacy": "/legal/privacy", "/cookies": "/legal/cookies", "/terms": "/legal/terms", "/legal/refunds": "/legal/terms" };
  if (ALIAS[location.pathname]) history.replaceState(null, "", ALIAS[location.pathname] + location.hash);
  await header($("#header"), { active: ["/sell", "/help", "/"].includes(location.pathname) ? location.pathname : location.pathname === "/contact" ? "/help" : null });
  footer($("#footer"));
  const p = location.pathname;
  try {
    let m;
    if ((m = p.match(/^\/events\/([^/]+)$/))) await eventPage(decodeURIComponent(m[1]));
    else if ((m = p.match(/^\/orders\/([^/]+)$/))) await orderPage(decodeURIComponent(m[1]));
    else if ((m = p.match(/^\/legal\/([a-z-]+)$/))) await legal(m[1]);
    else if (p === "/sell") sellPage();
    else if (p === "/help") await help();
    else if (p === "/contact") await contact();
    else if (p === "/unsubscribe") unsubscribe();
    else if (p === "/" || p === "/browse") await home();
    else if (p === "/signin") { await home(); const { authDialog } = await import("/assets/core.js"); if (!(await me())) authDialog("signin", { onDone: () => { location.href = "/account"; } }); }
    else render(main, html`<div class="wrap section"><div class="card pad-lg"><h1>Page not found</h1><a class="btn btn-primary" href="/">Browse events</a></div></div>`);
  } catch (err) {
    render(main, html`<div class="wrap section"><div class="card pad-lg"><h1>${err.status === 404 ? "Not found" : "Something went wrong"}</h1><p>${err.message}</p><a class="btn btn-primary" href="/">Browse events</a></div></div>`);
  }
})();
