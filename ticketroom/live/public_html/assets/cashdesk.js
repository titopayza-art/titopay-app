// The top-up desk and cash-out desk, shared by the gate scanner (/scan),
// the organiser's event workspace and the admin portal. Made for a phone in
// one hand: find the guest, pick an amount, cash or card, confirm, done.
// Every amount, balance and outcome comes from the server.
import { html, render, $, $$, get, post, toast, moneyExact, fmtTime, fmtDateTime, badge, empty, spinner, idem, dialog, parseRand } from "/assets/core.js";
import { Camera, readNfc, nfcSupported, beep } from "/assets/reader.js";

const rand = (c) => moneyExact(c).replace(/\.00$/, "");

export async function deskApp(el, eventId, { onBack, backLabel = "Back" } = {}) {
  let ctx, tab = "topup", guest = null, amount = 0, method = null, cam = null, nfc = null, last = null;
  const stopReaders = () => { cam?.stop(); cam = null; nfc?.abort(); nfc = null; };
  render(el, spinner());
  try { ctx = await get(`/api/cashdesk/events/${eventId}`); } catch (err) { return render(el, html`<p class="callout warn">${err.message}</p>`); }

  const frame = (body) => html`<div class="desk">
    <div class="row between"><div><div class="small muted">${ctx.event.title}</div><h1 class="mb-0">${tab === "cashout" ? "Cash-out desk" : tab === "cashup" ? "Cash-up" : "Top-up desk"}</h1></div>
      ${onBack ? html`<button class="btn btn-ghost btn-sm" data-back>${backLabel}</button>` : ""}</div>
    ${ctx.test ? html`<p class="callout warn small mt">Test mode: top-ups made now are practice money, marked TEST, like test ticket sales.</p>` : ""}
    <div class="tabs mt" role="tablist">${[["topup", "Top up"], ["cashout", "Cash out"], ["cashup", "Cash-up"]].map(([k, l]) => html`<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`)}</div>
    <div class="mt">${body}</div></div>`;
  const wire = () => {
    $("[data-back]", el)?.addEventListener("click", () => { stopReaders(); onBack(); });
    $$("[data-tab]", el).forEach((b) => b.addEventListener("click", () => { stopReaders(); tab = b.dataset.tab; draw(); }));
  };
  function draw() {
    if (tab === "cashup") return cashup();
    if (tab === "cashout") return cashout();
    return guest ? topupForm() : find();
  }

  // ---- 1. find the guest
  function find(message) {
    render(el, frame(html`${!ctx.event.cashlessOpen ? html`<p class="callout warn">Cashless is not open for this event right now.</p>` : ""}
      <section class="card stack"><h2 class="mb-0">Find the guest</h2><p class="small muted mb-0">Tap or scan their wristband, or type the code on the band, their email or mobile number.</p>
        <div class="row">${nfcSupported() ? html`<button class="btn btn-dark btn-lg grow" data-nfc>Tap wristband</button>` : ""}<button class="btn btn-dark btn-lg grow" data-cam>Scan</button></div>
        <div class="camera" id="dcam"></div>
        <form class="row" id="dfind"><label class="sr-only" for="dq">Band code, email or mobile number</label><input id="dq" class="grow" placeholder="Band code, email or mobile" autocomplete="off" autocapitalize="characters"><button class="btn btn-primary">Find</button></form>
        ${message ? html`<p class="callout bad mb-0" role="alert">${message}</p>` : ""}</section>`));
    wire();
    const go = async (q) => {
      stopReaders();
      try { guest = (await post(`/api/cashdesk/events/${eventId}/lookup`, { query: q })).guest; amount = 0; method = null; beep(true); draw(); }
      catch (err) { beep(false); find(err.message); }
    };
    $("#dfind", el).addEventListener("submit", (e) => { e.preventDefault(); const v = $("#dq", el).value.trim(); if (v) go(v); });
    $("[data-cam]", el).addEventListener("click", async () => { cam = new Camera($("#dcam", el), go); try { await cam.start(); } catch { toast("Camera unavailable. Type the band code instead.", "bad"); } });
    $("[data-nfc]", el)?.addEventListener("click", async () => { nfc = new AbortController(); try { await readNfc(go, nfc.signal); toast("Hold the wristband to the back of the phone."); } catch (err) { toast(`NFC: ${err.message}`, "bad"); } });
    $("#dq", el).focus();
  }

  // ---- 2. amount, cash or card, confirm
  function topupForm() {
    const room = ctx.limits.maxBalanceCents - guest.balanceCents;
    const ready = amount >= ctx.limits.minCents && method;
    render(el, frame(html`<section class="card desk-guest"><div class="row between"><div><h2 class="mb-0">${guest.name}</h2><div class="small muted">${guest.email}${guest.band ? ` · band ${guest.band.displayCode}` : " · no band linked"}</div></div>
        <div class="right"><div class="small muted">Balance</div><div class="desk-bal">${moneyExact(guest.balanceCents)}</div></div></div></section>
      <h2 class="mt">How much?</h2>
      <div class="desk-amounts">${ctx.limits.quickCents.map((c) => html`<button type="button" class="desk-amt" data-amt="${c}" aria-pressed="${amount === c}" ${c > room ? "disabled" : ""}>${rand(c)}</button>`)}</div>
      <div class="field mt"><label for="damt">Other amount (R)</label><input id="damt" inputmode="decimal" placeholder="e.g. 150" value="${amount && !ctx.limits.quickCents.includes(amount) ? String(amount / 100) : ""}"></div>
      <h2 class="mt">Paid with</h2>
      <div class="desk-method"><button type="button" data-m="cash" aria-pressed="${method === "cash"}">Cash</button><button type="button" data-m="card" aria-pressed="${method === "card"}">Card machine</button></div>
      <label class="check mt"><input type="checkbox" id="drec" checked><span>Send the guest a receipt (email, and SMS if they have a mobile number)</span></label>
      <button class="btn btn-primary btn-block btn-lg mt" data-go ${ready ? "" : "disabled"}>${ready ? `Top up ${rand(amount)} (${method === "cash" ? "cash" : "card"})` : "Choose an amount and how they paid"}</button>
      <button class="btn btn-link btn-block" data-other>Another guest</button>
      <p class="tiny muted center">Most a balance can hold: ${rand(ctx.limits.maxBalanceCents)}. Your desk today: ${rand(ctx.limits.todayCents)} of ${rand(ctx.limits.deskDailyCapCents)}.</p>`));
    wire();
    $$("[data-amt]", el).forEach((b) => b.addEventListener("click", () => { amount = Number(b.dataset.amt); topupForm(); }));
    $("#damt", el).addEventListener("change", (e) => { const c = parseRand(e.target.value); if (c) { amount = c; topupForm(); } else if (e.target.value) toast("Enter an amount like 150 or 150.50.", "bad"); });
    $$("[data-m]", el).forEach((b) => b.addEventListener("click", () => { const c = parseRand($("#damt", el).value); if (c) amount = c; method = b.dataset.m; topupForm(); }));
    $("[data-other]", el).addEventListener("click", () => { guest = null; draw(); });
    $("[data-go]", el)?.addEventListener("click", () => confirm($("#drec", el).checked));
  }
  function confirm(receipt) {
    const key = idem();
    const d = dialog("Check before you top up", html`<div class="stack center"><p class="mb-0">${method === "cash" ? `Take ${rand(amount)} in cash from` : `Charge ${rand(amount)} on the card machine for`}</p><p class="desk-bal mb-0">${guest.name}</p>
      <p class="small muted mb-0">${method === "card" ? "Only confirm once the card machine says approved." : "Count the cash before you confirm."}</p>
      <button class="btn btn-good btn-block btn-lg" data-yes>Yes, top up ${rand(amount)}</button><button class="btn btn-ghost btn-block" data-close>Cancel</button></div>`);
    $("[data-yes]", d).addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        const r = await post(`/api/cashdesk/events/${eventId}/topups`, { userId: guest.userId, amountCents: amount, method, idempotencyKey: key, receipt });
        d.close(); last = r; ctx.limits.todayCents += r.replay ? 0 : r.topup.amountCents; beep(true); done();
      } catch (err) { e.target.disabled = false; toast(err.message, "bad"); beep(false); }
    });
  }
  function done() {
    const r = last;
    render(el, frame(html`<div class="verdict ok" role="status" aria-live="assertive"><div class="big">TOPPED UP</div>
        <div class="desk-done">${rand(r.topup.amountCents)} ${r.topup.method === "cash" ? "cash" : "by card"}. New balance ${moneyExact(r.guest.balanceCents)}</div>
        <div class="small">${r.guest.name} · <span class="mono">${r.topup.reference}</span>${r.topup.test ? " · TEST" : ""}</div></div>
      <button class="btn btn-primary btn-block btn-lg mt" data-next>Next guest</button>
      <button class="btn btn-ghost btn-block" data-undo>Undo this top-up (within ${ctx.limits.undoMinutes} minutes)</button>`));
    wire();
    $("[data-next]", el).addEventListener("click", () => { guest = null; last = null; draw(); });
    $("[data-undo]", el).addEventListener("click", async () => {
      try {
        const u = await post(`/api/cashdesk/events/${eventId}/topups/${r.topup.reference}/undo`, {});
        ctx.limits.todayCents -= r.topup.amountCents; toast(`Undone. Balance back to ${moneyExact(u.guest.balanceCents)}. Give the money back.`, "good"); guest = null; draw();
      } catch (err) { toast(err.message, "bad"); }
    });
  }

  // ---- cash-out desk: the guest shows the code from their wallet
  async function cashout(message) {
    // The organiser may have just opened (or closed) the cash-out desk.
    if (!message) { try { ctx = await get(`/api/cashdesk/events/${eventId}`); } catch { /* keep what we have */ } }
    const open = ctx.settings.cashoutDeskOpen;
    render(el, frame(html`${!open ? html`<p class="callout warn">The cash-out desk is closed. The organiser opens it near the end of the event (Vendors & POS).</p>` : ""}
      <section class="card stack"><h2 class="mb-0">Pay out a balance in cash</h2><p class="small muted mb-0">The guest opens their wallet, chooses Cash at the venue and shows you a code.</p>
        <button class="btn btn-dark btn-lg" data-cam ${open ? "" : "disabled"}>Scan the code</button><div class="camera" id="ccam"></div>
        <form class="row" id="cfind"><label class="sr-only" for="cq">Cash-out code</label><input id="cq" class="grow mono" placeholder="Cash-out code, e.g. ABCD-EFGH" autocomplete="off" autocapitalize="characters" ${open ? "" : "disabled"}><button class="btn btn-primary" ${open ? "" : "disabled"}>Find</button></form>
        ${message ? html`<p class="callout bad mb-0" role="alert">${message}</p>` : ""}</section>`));
    wire();
    const go = async (code) => {
      stopReaders();
      try {
        const { cashout: c } = await post(`/api/cashdesk/events/${eventId}/cashouts/find`, { code });
        if (c.status !== "requested") return cashout(c.status === "paid" ? `Already paid${c.paidAt ? ` at ${fmtTime(c.paidAt)}` : ""}.` : `This cash-out is ${c.status}.`);
        render(el, frame(html`<section class="card stack center"><div class="small muted">Pay in cash to</div><h2 class="mb-0">${c.name}</h2><div class="desk-bal">${moneyExact(c.amountCents)}</div>
          ${c.feeCents ? html`<div class="small muted">after a ${moneyExact(c.feeCents)} cash-out fee</div>` : ""}${c.test ? html`<span class="badge warn">Test money</span>` : ""}
          <button class="btn btn-good btn-block btn-lg" data-pay>I have paid ${rand(c.amountCents)} in cash</button><button class="btn btn-ghost btn-block" data-cancel>Not now</button></section>`));
        wire();
        $("[data-cancel]", el).addEventListener("click", () => cashout());
        $("[data-pay]", el).addEventListener("click", async (e) => {
          e.target.disabled = true;
          try {
            const r = (await post(`/api/cashdesk/events/${eventId}/cashouts/pay`, { code })).cashout; beep(true);
            render(el, frame(html`<div class="verdict ok" role="status"><div class="big">PAID OUT</div><div class="desk-done">${moneyExact(r.amountCents)} cash to ${r.name}</div><div class="small mono">${r.reference}</div></div>
              <button class="btn btn-primary btn-block btn-lg mt" data-again>Next guest</button>`));
            wire(); $("[data-again]", el).addEventListener("click", () => cashout());
          } catch (err) { beep(false); cashout(err.message); }
        });
      } catch (err) { beep(false); cashout(err.message); }
    };
    $("#cfind", el).addEventListener("submit", (e) => { e.preventDefault(); const v = $("#cq", el).value.trim(); if (v) go(v); });
    $("[data-cam]", el).addEventListener("click", async () => { cam = new Camera($("#ccam", el), go); try { await cam.start(); } catch { toast("Camera unavailable. Type the code instead.", "bad"); } });
  }

  // ---- cash-up: this desk's totals, and every desk for the organiser
  async function cashup() {
    render(el, frame(spinner()));
    let c;
    try { c = await get(`/api/cashdesk/events/${eventId}/cashup`); } catch (err) { return render(el, frame(html`<p class="callout bad">${err.message}</p>`)); }
    const m = c.mine;
    render(el, frame(html`<div id="slip"><p class="small muted">Cash-up for ${m.name}, ${fmtDateTime(c.generatedAt)}</p>
      <div class="kpis"><div class="kpi card"><div class="k">Cash taken</div><div class="v">${moneyExact(m.cash_cents)}</div><div class="s">${m.cash_count} top-ups</div></div>
        <div class="kpi card"><div class="k">Card machine</div><div class="v">${moneyExact(m.card_cents)}</div><div class="s">${m.card_count} top-ups</div></div>
        <div class="kpi card"><div class="k">Cash paid out</div><div class="v">${moneyExact(m.cash_paid_out_cents)}</div><div class="s">${m.cash_paid_out_count} cash-outs</div></div>
        <div class="kpi card"><div class="k">Cash in the drawer</div><div class="v">${moneyExact(m.drawer_cents)}</div><div class="s">should be in your cash box</div></div></div>
      ${m.undone_count ? html`<p class="small muted">${m.undone_count} top-ups undone or reversed (${moneyExact(m.undone_cents)}), not counted above.</p>` : ""}
      ${c.desks ? html`<h2 class="mt-lg">Every desk at this event</h2><div class="table-wrap"><table><thead><tr><th>Desk</th><th class="num">Cash</th><th class="num">Card</th><th class="num">Paid out</th><th class="num">In drawer</th></tr></thead><tbody>
        ${c.desks.map((d) => html`<tr><td>${d.name}<div class="tiny muted">${d.email}</div></td><td class="num">${moneyExact(d.cash_cents)}</td><td class="num">${moneyExact(d.card_cents)}</td><td class="num">${moneyExact(d.cash_paid_out_cents)}</td><td class="num">${moneyExact(d.drawer_cents)}</td></tr>`)}
        <tr><td><strong>All desks</strong></td><td class="num"><strong>${moneyExact(c.totals.cash_cents || 0)}</strong></td><td class="num"><strong>${moneyExact(c.totals.card_cents || 0)}</strong></td><td class="num"><strong>${moneyExact(c.totals.cash_paid_out_cents || 0)}</strong></td><td class="num"><strong>${moneyExact(c.totals.drawer_cents || 0)}</strong></td></tr></tbody></table></div>` : ""}
      <h2 class="mt-lg">Your top-ups</h2>${c.items.length ? html`<div class="table-wrap"><table class="desk-list"><thead><tr><th>Time</th><th>Guest</th><th class="num">Amount</th></tr></thead><tbody>
        ${c.items.map((t) => html`<tr><td>${fmtTime(t.createdAt)}</td><td>${t.guest}<div class="tiny mono muted">${t.reference}</div></td>
          <td class="num"><div class="amt">${moneyExact(t.amountCents)}</div><div class="tiny muted">${t.method === "cash" ? "cash" : "card"}${t.test ? ", test" : ""}</div>
          ${t.status === "confirmed" ? (c.manager ? html`<button class="btn-link tiny" data-rev="${t.reference}">Reverse</button>` : "") : badge(t.status)}</td></tr>`)}</tbody></table></div>` : empty("No top-ups at this desk yet.")}</div>
      <div class="row mt"><button class="btn btn-dark grow" data-print>Print cash-up slip</button><button class="btn btn-ghost grow" data-csv>Download CSV</button></div>`));
    wire();
    $("[data-print]", el).addEventListener("click", () => window.print());
    $("[data-csv]", el).addEventListener("click", () => {
      const rows = [["time", "reference", "guest", "method", "amount_rand", "status", "test"], ...c.items.map((t) => [t.createdAt, t.reference, t.guest, t.method, (t.amountCents / 100).toFixed(2), t.status, t.test ? "yes" : "no"]),
        [], ["cash_taken", (m.cash_cents / 100).toFixed(2)], ["card_machine", (m.card_cents / 100).toFixed(2)], ["cash_paid_out", (m.cash_paid_out_cents / 100).toFixed(2)], ["cash_in_drawer", (m.drawer_cents / 100).toFixed(2)]];
      const csv = rows.map((r) => r.map((x) => `"${String(x ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `cash-up-${ctx.event.title.replace(/\W+/g, "-").toLowerCase()}.csv` }).click();
    });
    $$("[data-rev]", el).forEach((b) => b.addEventListener("click", () => {
      const d = dialog("Reverse a top-up", html`<form class="stack"><p class="mb-0">The money comes off the guest's balance (only if they have not spent it). Give the money back to the guest.</p>
        <div class="field"><label for="rr">Why?</label><input id="rr" name="reason" required minlength="3"></div><button class="btn btn-danger">Reverse ${b.dataset.rev}</button></form>`);
      $("form", d).addEventListener("submit", async (e) => {
        e.preventDefault();
        try { await post(`/api/cashdesk/events/${eventId}/topups/${b.dataset.rev}/reverse`, { reason: $("#rr", d).value }); d.close(); toast("Top-up reversed.", "good"); cashup(); } catch (err) { toast(err.message, "bad"); }
      });
    }));
  }
  draw();
}

// The events this person can run a desk for, then the desk itself.
export async function deskPicker(el, { title = "Wristbands & wallets", intro } = {}) {
  render(el, spinner());
  const { events } = await get("/api/cashdesk/events");
  const pick = () => render(el, html`<h1>${title}</h1>${intro ? html`<p class="muted">${intro}</p>` : ""}
    ${events.length ? html`<div class="stack">${events.map((e) => html`<button class="card btn-block row between" data-ev="${e.id}"><span><strong>${e.title}</strong><br><span class="small muted">${e.organiser_name} · ${fmtDateTime(e.starts_at)}${e.ended ? " · over" : ""}${e.cashoutDeskOpen ? " · cash-out desk open" : ""}</span></span><span>→</span></button>`)}</div>`
      : empty("No cashless events to run a desk for.")}`);
  pick();
  el.onclick = (e) => {
    const b = e.target.closest("[data-ev]");
    if (b) { el.onclick = null; deskApp(el, b.dataset.ev, { onBack: () => deskPicker(el, { title, intro }), backLabel: "All events" }); }
  };
}
