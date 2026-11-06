import { html, render, $, $$, get, post, moneyExact, fmtTime, toast, parseRand } from "/assets/core.js?build=2026-10-22-phases";

const endpoint = (id) => `/api/staff/events/${encodeURIComponent(id)}`;
const newKey = () => `door_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;

export async function boxOfficeApp(root, eventId, { onBack = null, backLabel = "Back", baseUrl = null, partnerMode = false } = {}) {
  const apiBase = baseUrl || endpoint(eventId);
  let data;
  try { data = await get(`${apiBase}/box-office`); }
  catch (err) { render(root, html`<section class="card"><h2>Box office</h2><p>${err.message}</p></section>`); return; }
  let shift = data.shift;
  const offlineNotice = () => navigator.onLine === false ? "You're offline. Door sales are disabled until the server connection is restored." : "Sales require a live connection. Tickets are never issued from an offline queue.";
  const renderShift = () => {
    const s = shift;
    render(root, html`<div class="row between"><div><div class="small muted">Box office</div><h1 class="mb-0">${data.event.title}</h1></div>${onBack ? html`<button class="btn btn-ghost btn-sm" data-back>${backLabel}</button>` : ""}</div>
      <p class="callout mt" id="door-network">${offlineNotice()}</p>
      ${!partnerMode || data.retailChannels?.includes("physical") ? (s ? html`<section class="card mt"><div class="card-title"><div><h2>Shift cash-up</h2><p class="small muted mb-0">Opened ${fmtTime(s.openedAt)} · cash and external tenders are recorded separately.</p></div><span class="badge ${s.status === "open" ? "good" : "plain"}">${s.status}</span></div>
        <div class="grid-2"><div class="kpi"><div class="k">Cash to account for</div><div class="v">${moneyExact(s.expectedCashCents)}</div><div class="s">Float ${moneyExact(s.openingFloatCents)} + gross cash sales ${moneyExact(s.cashSalesCents)}${s.cashRefundsCents ? ` · ${moneyExact(s.cashRefundsCents)} in refunds settled separately by TicketRoom` : ""}</div></div>
        <div class="kpi"><div class="k">External payments to reconcile</div><div class="v">${moneyExact(s.expectedCardCents)}</div><div class="s">Gross terminal / QR sales ${moneyExact(s.cardSalesCents)}${s.cardRefundsCents ? ` · ${moneyExact(s.cardRefundsCents)} in refunds settled separately by TicketRoom` : ""}</div></div></div>
        ${s.status === "open" ? html`<form class="stack mt" id="cashup-form"><h3>Close shift</h3><p class="small muted mb-0">Enter drawer cash including the opening float, and the gross card/QR terminal amount recorded. TicketRoom refunds are paid separately and do not reduce these till totals. The variance is saved for reconciliation.</p>
          <div class="grid-2"><div class="field"><label for="counted-cash">Cash counted (R)</label><input id="counted-cash" inputmode="decimal" placeholder="0.00" required></div><div class="field"><label for="counted-card">External card / QR total (R)</label><input id="counted-card" inputmode="decimal" placeholder="0.00" required></div></div>
          <button class="btn btn-dark">Save cash-up and close shift</button></form>` : html`<p class="callout mt mb-0">Closed ${fmtTime(s.closedAt)}. Cash variance: <strong>${moneyExact(s.cashVarianceCents)}</strong>. External-payment variance: <strong>${moneyExact(s.cardVarianceCents)}</strong>.</p><button class="btn btn-ghost mt" data-new-shift>Open next shift</button>`}
      </section>` : html`<section class="card mt"><h2>Open cashier shift</h2><p class="small muted">Record the float already in the cash drawer before taking sales. Use zero if there is no opening float.</p><form class="row" id="open-shift"><label class="grow" for="opening-float">Opening cash float (R)</label><input id="opening-float" inputmode="decimal" value="0.00" required><button class="btn btn-primary">Open shift</button></form></section>`) : ""}
      ${orderPanel(data, eventId, partnerMode)}
      ${data.pending?.length ? html`<section class="card mt"><h2>Sales awaiting tender</h2><p class="small muted">These reservations are held on the server for up to 10 minutes. Do not take payment after the expiry time.</p><ul>${data.pending.map((p) => html`<li class="row between"><span>Order ${p.reference} · ${p.tender_method.replace("_", " ")} · ${moneyExact(p.total_cents)} · expires ${fmtTime(p.expires_at)}</span><button class="btn btn-ghost btn-sm" data-resume="${p.reference}">Continue</button></li>`)}</ul></section>` : ""}
      ${data.shifts?.filter((x) => x.status === "closed").length ? html`<section class="card mt"><h2>Closed shifts</h2><div class="table-wrap"><table><thead><tr><th>Cashier</th><th>Closed</th><th class="num">Cash variance</th><th class="num">Card / QR variance</th></tr></thead><tbody>${data.shifts.filter((x) => x.status === "closed").map((x) => html`<tr><td>${x.cashierName}</td><td>${fmtTime(x.closedAt)}</td><td class="num">${moneyExact(x.cashVarianceCents)}</td><td class="num">${moneyExact(x.cardVarianceCents)}</td></tr>`)}</tbody></table></div></section>` : ""}`);
    $(`[data-back]`, root)?.addEventListener("click", onBack);
    $(`[data-new-shift]`, root)?.addEventListener("click", () => { shift = null; renderShift(); });
    $$('[data-resume]', root).forEach((button) => button.addEventListener("click", () => {
      const p = data.pending.find((x) => x.reference === button.dataset.resume);
      if (p) tenderConfirmation(root, apiBase, { order: { reference: p.reference, totalCents: Number(p.total_cents), expiresAt: p.expires_at }, accessKey: p.accessKey }, p.tender_method, reload);
    }));
    const openForm = $("#open-shift", root);
    openForm?.addEventListener("submit", async (e) => { e.preventDefault(); const cents = parseRand($("#opening-float", openForm).value); if (cents === null) return toast("Enter a valid opening float.", "bad");
      const b = $("button", openForm); b.disabled = true; try { const r = await post(`${apiBase}/door-shifts`, { openingFloatCents: cents }); shift = r.shift; await reload(); } catch (err) { toast(err.message, "bad"); b.disabled = false; } });
    const closeForm = $("#cashup-form", root);
    closeForm?.addEventListener("submit", async (e) => { e.preventDefault(); const cash = parseRand($("#counted-cash", closeForm).value), card = parseRand($("#counted-card", closeForm).value); if (cash === null || card === null) return toast("Enter valid Rand amounts for both totals.", "bad");
      const b = $("button", closeForm); b.disabled = true; try { const r = await post(`${apiBase}/door-shifts/${shift.id}/close`, { countedCashCents: cash, countedCardCents: card }); shift = r.shift; await reload(); } catch (err) { toast(err.message, "bad"); b.disabled = false; } });
    wireOrderForm(root, data, eventId, reload, apiBase);
  };
  const reload = async () => { const r = await get(`${apiBase}/box-office`); data = r; shift = r.shift; renderShift(); };
  renderShift();
}

function orderPanel(data, eventId, partnerMode = false) {
  const ev = data.event, now = Date.now();
  const salesOpen = (!ev.sales_start_at || new Date(ev.sales_start_at).getTime() <= now) && new Date(ev.sales_end_at || ev.ends_at).getTime() > now;
  if (ev.status !== "published" || !salesOpen) return html`<section class="card mt"><h2>Sell tickets</h2><p class="mb-0">Door sales are available only while this published event's ticket sales are open.</p></section>`;
  const tickets = data.ticketTypes.filter((t) => t.status === "on_sale" && Number(t.quantity_total) > Number(t.quantity_sold) + Number(t.quantity_held)
    && (!t.sales_start_at || new Date(t.sales_start_at).getTime() <= now) && (!t.sales_end_at || new Date(t.sales_end_at).getTime() > now));
  if (!tickets.length) return html`<section class="card mt"><h2>Sell tickets</h2><p class="mb-0">No ticket types are currently available for sale.</p></section>`;
  return html`<section class="card mt"><div class="card-title"><div><h2>Sell a walk-up ticket</h2><p class="small muted mb-0">The server reserves stock, applies the current event fees, then issues and emails the ticket after payment is recorded.</p></div></div>
    <form class="stack" id="door-form"><fieldset class="stack"><legend><strong>Tickets</strong></legend>${tickets.map((t) => { const left = Math.max(0, Number(t.quantity_total) - Number(t.quantity_sold) - Number(t.quantity_held)); const max = Math.min(20, Number(t.per_order_limit), left); return html`<div class="grid-2 door-ticket-row"><label for="door-${t.id}"><strong>${t.name}</strong><span class="small muted"> · ${t.price_cents > 0 ? moneyExact(t.price_cents) : "Free"} · ${left.toLocaleString("en-ZA")} left</span></label><input id="door-${t.id}" data-qty="${t.id}" type="number" min="0" max="${max}" step="1" value="0" inputmode="numeric"></div>`; })}</fieldset>
      <div class="grid-2"><div class="field"><label for="buyer-name">Buyer name</label><input id="buyer-name" required minlength="2" maxlength="120" autocomplete="name"></div><div class="field"><label for="buyer-email">Email for tickets and receipt</label><input id="buyer-email" type="email" required maxlength="254" autocomplete="email"></div></div>
      <div class="grid-2"><div class="field"><label for="buyer-phone">Mobile <span class="muted">(optional)</span></label><input id="buyer-phone" type="tel" autocomplete="tel"></div><div class="field"><label for="promo-code">Promo code <span class="muted">(optional)</span></label><input id="promo-code" maxlength="40" autocomplete="off"></div></div>
      <div id="door-quote" class="callout" aria-live="polite">Choose tickets to check the current price and fees.</div>
      <div class="field"><label for="tender-method">How will the buyer pay?</label><select id="tender-method">${!partnerMode || data.retailChannels?.includes("online") ? html`<option value="online">TicketRoom secure online checkout</option>` : ""}${!partnerMode || data.retailChannels?.includes("physical") ? html`<option value="cash">Cash</option><option value="yoco">Yoco terminal or QR payment</option><option value="snapscan">SnapScan</option><option value="titopay">TitoPay</option><option value="external_card">Other card terminal</option>` : ""}</select></div>
      <p class="small muted mb-0">${partnerMode ? "Online checkout uses TicketRoom’s configured secure payment providers. For cash, Yoco, SnapScan, TitoPay or another terminal, verify success on the device/app and enter its reference. Manual tenders are recorded, not automatically verified. Stay online; offline sales are disabled." : "For cash and external payment apps/terminals, verify the payment succeeded on the device or provider account before recording it. TicketRoom records the cashier's confirmation and reference; it does not verify third-party terminal transactions. All door sales require a live connection."}</p>
      <div class="row end"><button class="btn btn-primary" id="door-create">Reserve tickets and continue</button></div></form></section>`;
}

function wireOrderForm(root, data, eventId, reload, apiBase = endpoint(eventId)) {
  const form = $("#door-form", root); if (!form) return;
  const storageKey = `tr-door-order-key:${eventId}`;
  let idemKey = "";
  try { idemKey = sessionStorage.getItem(storageKey) || ""; } catch { /* current-page fallback */ }
  if (!idemKey) { idemKey = newKey(); try { sessionStorage.setItem(storageKey, idemKey); } catch { /* in-memory fallback */ } }
  const selected = () => $$('[data-qty]', form).map((i) => ({ ticketTypeId: i.dataset.qty, quantity: Number(i.value) || 0 })).filter((x) => x.quantity > 0);
  const createButton = $("#door-create", form);
  const syncOnline = () => { const off = navigator.onLine === false; createButton.disabled = off; const note = $("#door-network", root); if (note) note.textContent = off ? "You're offline. Door sales are disabled until the server connection is restored." : "Sales require a live connection. Tickets are never issued from an offline queue."; };
  syncOnline(); window.addEventListener("online", syncOnline); window.addEventListener("offline", syncOnline);
  const quoteBox = $("#door-quote", form); let quoteSequence = 0, quoteTimer = 0;
  const updateQuote = async () => {
    const seq = ++quoteSequence, items = selected();
    if (!items.length) { quoteBox.textContent = "Choose tickets to check the current price and fees."; return; }
    quoteBox.textContent = "Checking current prices and fees…";
    try {
      const result = await post("/api/public/checkout/quote", { eventSlug: data.event.slug, items, promoCode: $("#promo-code", form).value.trim() || undefined });
      if (seq !== quoteSequence) return; const q = result.quote;
      render(quoteBox, html`<div class="row between"><span>Tickets</span><strong>${moneyExact(q.subtotalCents)}</strong></div>${q.discountCents ? html`<div class="row between"><span>Discount${q.promoCode ? ` · ${q.promoCode}` : ""}</span><strong>−${moneyExact(q.discountCents)}</strong></div>` : ""}<div class="row between"><span>Fees</span><strong>${moneyExact(q.feeCents)}</strong></div><hr><div class="row between"><strong>Total due</strong><strong>${moneyExact(q.totalCents)}</strong></div>`);
    } catch (err) { if (seq === quoteSequence) quoteBox.textContent = err.message; }
  };
  $$('[data-qty]', form).forEach((input) => input.addEventListener("input", () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(updateQuote, 200); }));
  $("#promo-code", form).addEventListener("change", updateQuote);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (navigator.onLine === false) return toast("You're offline. No sale was recorded; reconnect and try again.", "bad");
    const items = selected(); if (!items.length) return toast("Choose at least one ticket.", "bad");
    if (items.reduce((n, i) => n + i.quantity, 0) > 20) return toast("You can sell up to 20 tickets in one order.", "bad");
    const method = $("#tender-method", form).value, button = $("#door-create", form); if (navigator.onLine === false) return toast("You're offline. No sale was recorded; reconnect and try again.", "bad"); button.disabled = true;
    try {
      const r = await post(`${apiBase}/door-orders`, { items, idempotencyKey: idemKey, tenderMethod: method, promoCode: $("#promo-code", form).value.trim() || undefined,
        buyer: { fullName: $("#buyer-name", form).value.trim(), email: $("#buyer-email", form).value.trim(), phone: $("#buyer-phone", form).value.trim() || undefined } });
      window.removeEventListener("online", syncOnline); window.removeEventListener("offline", syncOnline);
      idemKey = newKey(); try { sessionStorage.setItem(storageKey, idemKey); } catch { /* in-memory fallback */ }
      if (r.payment?.redirectUrl) { render(root, html`<section class="card"><p class="eyebrow">Order ${r.order.reference}</p><h2>Complete secure checkout</h2><p>Tickets are issued only after TicketRoom receives confirmation from the payment provider.</p><a class="btn btn-primary" href="${r.payment.redirectUrl}" target="_blank" rel="noopener">Open checkout</a> <button class="btn btn-ghost" data-refresh>Check shift and start another</button></section>`); $("[data-refresh]", root).addEventListener("click", reload); return; }
      if (r.order.status === "paid") { showReceipt(root, r, null, reload); return; }
      tenderConfirmation(root, apiBase, r, method, reload);
    } catch (err) {
      if (["door_order_closed", "door_order_assigned", "door_online_payment_started"].includes(err.code)) { idemKey = newKey(); try { sessionStorage.setItem(storageKey, idemKey); } catch { /* in-memory fallback */ } }
      toast(err.message, "bad"); button.disabled = navigator.onLine === false;
    }
  });
}

function tenderConfirmation(root, apiBase, order, method, reload) {
  const receiptUrl = `/orders/${encodeURIComponent(order.order.reference)}?k=${encodeURIComponent(order.accessKey)}`;
  const cash = method === "cash";
  render(root, html`<section class="card"><p class="eyebrow">Order ${order.order.reference} · reserved until ${fmtTime(order.order.expiresAt)}</p><h2>${cash ? "Collect cash" : "Verify the external payment"}</h2><p>${cash ? "Amount due" : "Charge this exact amount on the selected terminal or app, then record its successful receipt reference."}: <strong>${moneyExact(order.order.totalCents)}</strong></p>
    <form class="stack" id="record-tender">${cash ? html`<div class="field"><label for="cash-received">Cash received (R)</label><input id="cash-received" inputmode="decimal" required placeholder="${(order.order.totalCents / 100).toFixed(2)}"><span class="small muted">Change: <strong id="change-due">R 0.00</strong></span></div>` : html`<div class="field"><label for="external-ref">Successful transaction / receipt reference</label><input id="external-ref" minlength="2" maxlength="100" required autocomplete="off"></div>`}
      <div class="row"><button class="btn btn-primary">${cash ? "Confirm cash received and issue tickets" : "Record successful payment and issue tickets"}</button><button type="button" class="btn btn-ghost" data-view-order>View order status</button></div></form>
      <p class="small muted mt mb-0">This action records a cashier-confirmed external tender. It is not a payment-provider verification. Do not confirm until the money is received.</p><p class="small mt mb-0" id="tender-network" aria-live="polite"></p></section>`);
  const tenderButton = $("#record-tender button", root);
  const syncTenderOnline = () => { const off = navigator.onLine === false; tenderButton.disabled = off; $("#tender-network", root).textContent = off ? "Offline: this payment cannot be recorded. Keep the order reservation open and reconnect before continuing." : "Online: TicketRoom will record the tender and issue tickets after confirmation."; };
  syncTenderOnline(); window.addEventListener("online", syncTenderOnline); window.addEventListener("offline", syncTenderOnline);
  $("[data-view-order]", root).addEventListener("click", () => window.open(receiptUrl, "_blank", "noopener"));
  const received = $("#cash-received", root); received?.addEventListener("input", () => { const c = parseRand(received.value); $("#change-due", root).textContent = moneyExact(c === null ? 0 : Math.max(0, c - order.order.totalCents)); });
  $("#record-tender", root).addEventListener("submit", async (e) => { e.preventDefault(); if (navigator.onLine === false) return toast("You're offline. The tender was not recorded; reconnect before continuing.", "bad");
    const body = cash ? { cashReceivedCents: parseRand(received.value) } : { externalReference: $("#external-ref", root).value.trim() };
    if (cash && body.cashReceivedCents === null) return toast("Enter the cash received as a valid Rand amount.", "bad");
    const button = $("button", e.currentTarget); button.disabled = true;
    try { const r = await post(`${apiBase}/door-orders/${encodeURIComponent(order.order.reference)}/tender`, body); window.removeEventListener("online", syncTenderOnline); window.removeEventListener("offline", syncTenderOnline); showReceipt(root, order, r.tender, reload); }
    catch (err) { toast(err.message, "bad"); button.disabled = navigator.onLine === false; }
  });
}

function showReceipt(root, order, tender, reload) {
  const link = `/orders/${encodeURIComponent(order.order.reference)}?k=${encodeURIComponent(order.accessKey)}`;
  render(root, html`<section class="card"><p class="eyebrow">${tender?.receipt || "Order"} ${tender ? "· " : ""}${order.order.reference}</p><h2>Tickets issued</h2><p>The payment is recorded and the tickets and receipt have been emailed to the buyer.</p>
    ${tender ? html`<div class="callout"><div class="row between"><span>Tender</span><strong>${tender.method.replace("_", " ")}</strong></div><div class="row between"><span>Amount recorded</span><strong>${moneyExact(tender.amountCents)}</strong></div>${tender.method === "cash" ? html`<div class="row between"><span>Change</span><strong>${moneyExact(tender.changeCents)}</strong></div>` : ""}<div class="small muted mt">Receipt ${tender.receipt}</div></div>` : ""}
    <div id="retail-print-slip" class="print-slip"><strong>TicketRoom ticket sale</strong><div>Order ${order.order.reference}</div><div>${tender ? `Receipt ${tender.receipt}` : "Online checkout"}</div><div>${tender ? tender.method.replace("_", " ") : "Payment confirmed online"}</div><strong>${moneyExact(tender?.amountCents ?? order.order.totalCents)}</strong>${tender?.method === "cash" ? `<div>Change: ${moneyExact(tender.changeCents)}</div>` : ""}</div>
    <div class="row mt"><a class="btn btn-primary" href="${link}" target="_blank" rel="noopener">View / print tickets</a><label class="small" for="retail-paper">Receipt paper</label><select id="retail-paper" class="paper-select"><option value="80">80 mm thermal</option><option value="58">58 mm thermal</option><option value="a4">A4 printer</option></select><button class="btn btn-ghost" data-print-receipt>Print sale receipt</button><button class="btn btn-ghost" data-next>Start another sale</button></div></section>`);
  $("[data-print-receipt]", root).addEventListener("click", () => { const size = $("#retail-paper", root).value; document.body.classList.add("print-retail-slip", `print-width-${size}`); window.addEventListener("afterprint", () => document.body.classList.remove("print-retail-slip", "print-width-58", "print-width-80", "print-width-a4"), { once: true }); window.print(); window.setTimeout(() => document.body.classList.remove("print-retail-slip", "print-width-58", "print-width-80", "print-width-a4"), 3000); });
  $("[data-next]", root).addEventListener("click", reload);
}
