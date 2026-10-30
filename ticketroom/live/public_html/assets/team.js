// Event team and Team activity, shared by the organiser portal (an event's
// Gate staff and Team activity tabs) and the admin portal (an event's page).
// The API is the same shape on both: <base>/staff and <base>/team-activity.
import { html, render, $, $$, get, post, del, moneyExact, plural, fmtDateTime, fmtTime, toLocalInput, fromLocalInput, toast, onSubmit, empty, spinner, dialog, confirmDialog } from "/assets/core.js";

// Tables turn into one card per person on phones.
const STYLE = html`<style>
  .team-list { display: grid; gap: 10px; }
  .team-member { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 12px 14px; display: grid; gap: 8px; }
  .team-member .perm { display: flex; flex-wrap: wrap; gap: 6px 18px; }
  .team-member .who { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; justify-content: space-between; }
  .team-member .who > div { min-width: 0; overflow-wrap: anywhere; }
  .team-act td .tiny { display: block; }
  .team-act .person { background: none; border: 0; padding: 0; font: inherit; font-weight: 700; color: var(--navy-800, inherit); text-decoration: underline; cursor: pointer; text-align: left; min-height: 40px; }
  .team-filter { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); align-items: end; }
  @media (max-width: 760px) {
    .team-act table, .team-act tbody, .team-act tr, .team-act td { display: block; width: 100%; }
    .team-act thead { display: none; }
    .team-act tr { border-bottom: 1px solid var(--line); padding: 10px 12px; }
    .team-act td { border: 0; padding: 4px 0; text-align: left; display: flex; justify-content: space-between; gap: 12px; }
    .team-act td > * { text-align: right; }
    .team-act td::before { content: attr(data-label); font-weight: 700; color: var(--muted); text-align: left; flex: none; }
    .team-act td.who-cell::before { content: none; }
    .team-act td.who-cell > * { text-align: left; }
    .team-act .table-wrap { overflow-x: visible; }
  }
</style>`;

const PERMS = [["canScan", "Scan tickets"], ["canManageTags", "Wristbands (tag desk and top-ups)"], ["canSellTickets", "Box office (sell tickets at the door)"]];
const col = { canScan: "can_scan", canManageTags: "can_manage_tags", canSellTickets: "can_sell_tickets" };

// Who is on the event team, with what they may do. canEdit adds the form,
// the permission switches and Remove. viewer is "organiser" or "admin".
export async function teamSection(el, { base, list, canEdit, viewer = "organiser" }) {
  const staff = list || (await get(`${base}/staff`)).staff;
  const intro = viewer === "admin"
    ? "Add people by email and choose what each person can do at this event. The organiser sees them on their Gate staff tab, marked Added by TicketRoom. New people get an email invite to set a password; they sign in at ticketroom.co.za/scan."
    : "Add your team by email and choose what each person can do. They sign in at ticketroom.co.za/scan and only see this event. New people get an email invite to set a password.";
  render(el, html`${STYLE}<div class="card-title"><h3 id="team-h">Event team</h3><span class="small muted">${plural(staff.length, "person", "people")}</span></div>
    <p class="small muted">${intro}</p>
    ${staff.length ? html`<div class="team-list">${staff.map((s) => html`<div class="team-member" data-member="${s.id}" data-email="${s.email}">
      <div class="who"><div><strong>${s.full_name}</strong>${s.added_by_ticketroom ? html` <span class="badge plain">Added by TicketRoom</span>` : ""}<div class="small muted">${s.email}</div></div>
        <div class="small muted">${plural(s.admitted, "person", "people")} admitted</div></div>
      <div class="perm">${PERMS.map(([k, l]) => html`<label class="check" ${k === "canManageTags" ? "data-feature=tags" : ""}><input type="checkbox" data-perm="${k}" ${s[col[k]] ? "checked" : ""} ${canEdit ? "" : "disabled"}><span>${l}</span></label>`)}</div>
      ${canEdit ? html`<div class="row"><button type="button" class="btn btn-ghost btn-sm" data-remove="${s.id}">Remove from team</button></div>` : ""}
    </div>`)}</div>` : html`<p class="muted">No one on the event team yet.${canEdit ? " Add the first person below." : ""}</p>`}
    ${canEdit ? html`<form class="stack mt" data-team-add><div class="grid-2"><div class="field"><label for="tm-name">Name <span class="muted">(for new people)</span></label><input id="tm-name" name="fullName" maxlength="120" autocomplete="off"></div>
      <div class="field"><label for="tm-email">Email</label><input id="tm-email" name="email" type="email" required autocomplete="off"></div></div>
      ${PERMS.map(([k, l]) => html`<label class="check" ${k === "canManageTags" ? "data-feature=tags" : ""}><input type="checkbox" name="${k}" ${k === "canScan" ? "checked" : ""}><span>${l}</span></label>`)}
      <div class="row"><button class="btn btn-dark">Add to team</button></div></form>` : ""}`);
  const redraw = () => teamSection(el, { base, canEdit, viewer });
  if (!canEdit) return;
  onSubmit($("[data-team-add]", el), async (v) => {
    const r = await post(`${base}/staff`, { email: v.email, fullName: v.fullName || undefined, canScan: !!v.canScan, canManageTags: !!v.canManageTags, canSellTickets: !!v.canSellTickets });
    toast(r.invited ? `Invite emailed to ${v.email}. They can use their event tools once they set a password.` : r.updated ? "Permissions saved." : `${v.email} was added and told by email.`, "good");
    redraw();
  });
  $$("[data-member]", el).forEach((row) => $$("[data-perm]", row).forEach((box) => box.addEventListener("change", async () => {
    const body = { email: row.dataset.email };
    $$("[data-perm]", row).forEach((b) => { body[b.dataset.perm] = b.checked; });
    try { await post(`${base}/staff`, body); toast("Permissions saved.", "good"); }
    catch (err) { box.checked = !box.checked; toast(err.message, "bad"); }
  })));
  $$("[data-remove]", el).forEach((b) => b.addEventListener("click", async () => {
    const ok = await confirmDialog("Remove from the event team?", "They can no longer scan, run the desk or sell at the door for this event. What they already did stays in Team activity.", { confirm: "Remove", danger: true });
    if (!ok) return;
    try { await del(`${base}/staff/${b.dataset.remove}`); toast("Removed from the event team.", "good"); redraw(); } catch (err) { toast(err.message, "bad"); }
  }));
}

// ---------------------------------------------------------------- activity
const KINDS = [["", "Everything"], ["scan", "Ticket scans"], ["wristband", "Wristbands"], ["topup", "Top-ups"], ["cashout", "Cash-outs"], ["box_office", "Box office"]];
const ACTIONS = {
  admitted: "Admitted", already_used: "Already scanned", invalid: "Not valid", replaced: "Replaced code", refund_pending: "Refund in progress", wrong_event: "Wrong event",
  event_not_live: "Event not open", test_ticket: "Test ticket", resold: "Resold ticket", listed: "Up for resale", revoked: "Cancelled ticket", refunded: "Refunded ticket",
  linked: "Wristband linked", blocked: "Wristband blocked", unblocked: "Wristband unblocked", cancelled: "Wristband cancelled",
  topup: "Top-up", topup_undone: "Undid a top-up", topup_reversed: "Reversed a top-up", cashout_paid: "Cash-out paid",
  sale: "Box office sale", sale_refunded: "Sale refunded later", sale_cancelled: "Sale not completed", shift_opened: "Opened a cash-up shift", shift_closed: "Closed a cash-up shift",
};
const METHODS = { cash: "Cash", card: "Card", external_card: "Card machine", yoco: "Yoco", snapscan: "SnapScan", titopay: "Phone payment" };
const actionLabel = (i) => (i.kind === "wristband" && i.action === "replaced" ? "Wristband replaced" : ACTIONS[i.action] || i.action);

function refusedList(p, labels) {
  const parts = Object.entries(p.scans.refused).filter(([, n]) => n > 0).map(([k, n]) => `${labels[k] || k} ${n}`);
  return parts.length ? html`<span class="tiny muted">${parts.join(" · ")}</span>` : "";
}

export async function teamActivity(el, { base }) {
  render(el, spinner());
  const a = await get(`${base}/team-activity`);
  const t = a.totals;
  const cell = (label, v, sub = "", cls = "num") => html`<td class="${cls}" data-label="${label}"><span>${v}${sub ? html`<span class="tiny muted">${sub}</span>` : ""}</span></td>`;
  render(el, html`${STYLE}<div class="card-title"><h3>Team activity</h3><a class="btn btn-ghost btn-sm" href="${base}/team-activity?format=csv" download>Download CSV</a></div>
    <p class="small muted">What each person on the gate, the wristband desk and the box office did at this event. Tap a name to see every action with its time.</p>
    <div class="kpis"><div class="kpi"><div class="k">Admitted</div><div class="v">${t.admitted}</div><div class="s">${plural(t.refused, "scan")} refused${t.offline ? `, ${t.offline} sent after being offline` : ""}</div></div>
      <div class="kpi"><div class="k">Wristbands</div><div class="v">${t.wristbands}</div><div class="s">linked, replaced or blocked</div></div>
      <div class="kpi"><div class="k">Top-ups</div><div class="v">${moneyExact(t.topupCashCents + t.topupCardCents)}</div><div class="s">${plural(t.topups, "top-up")}: cash ${moneyExact(t.topupCashCents)}, card ${moneyExact(t.topupCardCents)}</div></div>
      <div class="kpi"><div class="k">Box office</div><div class="v">${moneyExact(t.boxOfficeCashCents + t.boxOfficeCardCents)}</div><div class="s">${plural(t.boxOfficeSales, "sale")}, ${plural(t.boxOfficeTickets, "ticket")}</div></div></div>
    <p class="small mt ${a.reconciled ? "muted" : "callout warn"}" data-reconciled="${a.reconciled ? "yes" : "no"}">${a.reconciled
      ? `These money totals match the desk cash-up (cash ${moneyExact(a.reports.deskCashCents)}, card ${moneyExact(a.reports.deskCardCents)}, cash paid out ${moneyExact(a.reports.cashPaidOutCents)}) and the box office shifts (cash ${moneyExact(a.reports.boxOfficeCashCents)}, card ${moneyExact(a.reports.boxOfficeCardCents)}).`
      : "These totals do not match the desk cash-up or the box office shifts. Please contact TicketRoom support."}</p>
    ${a.people.length ? html`<div class="team-act mt"><div class="table-wrap"><table><thead><tr><th>Person</th><th class="num">Admitted</th><th class="num">Refused</th><th class="num">Wristbands</th><th class="num">Top-ups</th><th class="num">Box office</th><th class="num">Cash taken</th><th class="num">Cash paid out</th><th>First and last action</th></tr></thead><tbody>
      ${a.people.map((p) => html`<tr data-person="${p.userId}"><td class="who-cell"><div><button type="button" class="person" data-open="${p.userId}">${p.name}</button>${p.addedByTicketroom ? html` <span class="badge plain">Added by TicketRoom</span>` : ""}<span class="tiny muted">${p.role} · ${p.email}</span></div></td>
        ${cell("Admitted", p.scans.admitted, p.scans.offline ? `${p.scans.offline} offline` : "")}
        ${cell("Refused", p.scans.refusedTotal, refusedList(p, a.refusedLabels))}
        ${cell("Wristbands", p.wristbands.total)}
        ${cell("Top-ups", html`${p.topups.count} · ${moneyExact(p.topups.totalCents)}`, `Cash ${moneyExact(p.topups.cashCents)} · Card ${moneyExact(p.topups.cardCents)}${p.topups.undoneCount ? ` · ${p.topups.undoneCount} undone` : ""}`)}
        ${cell("Box office", html`${p.boxOffice.count} · ${moneyExact(p.boxOffice.totalCents)}`, `${plural(p.boxOffice.tickets, "ticket")} · Cash ${moneyExact(p.boxOffice.cashCents)} · Card ${moneyExact(p.boxOffice.cardCents)}${p.boxOffice.refundedCount ? ` · ${moneyExact(p.boxOffice.refundedCents)} refunded` : ""}`)}
        ${cell("Cash taken", moneyExact(p.cash.takenCents))}
        ${cell("Cash paid out", moneyExact(p.cash.paidOutCents), p.cashouts.count ? plural(p.cashouts.count, "cash-out") : "")}
        ${cell("First and last action", p.firstAt ? `${fmtDateTime(p.firstAt)}` : "No actions yet", p.lastAt && p.lastAt !== p.firstAt ? `to ${fmtDateTime(p.lastAt)}` : "", "")}
      </tr>`)}</tbody></table></div></div>` : empty("No one has worked at this event yet.")}`);
  $$("[data-open]", el).forEach((b) => b.addEventListener("click", () => personTimeline(base, b.dataset.open)));
}

// One person's full list of actions, filtered by type and time.
async function personTimeline(base, userId) {
  const d = dialog("Team activity", html`${STYLE}<div data-tl>${spinner()}</div>`, { wide: true });
  const box = $("[data-tl]", d);
  const f = { kind: "", from: "", to: "" };
  const draw = async () => {
    const q = new URLSearchParams();
    if (f.kind) q.set("kind", f.kind);
    if (f.from) q.set("from", f.from);
    if (f.to) q.set("to", f.to);
    const url = `${base}/team-activity/${userId}`;
    const r = await get(`${url}${q.size ? `?${q}` : ""}`);
    q.set("format", "csv");
    render(box, html`<h3 class="mb-0">${r.person.name}</h3><p class="small muted">${r.person.role} · ${r.person.email}</p>
      <form class="team-filter" data-tl-filter><div class="field"><label for="tl-kind">Type</label><select id="tl-kind" name="kind">${KINDS.map(([k, l]) => html`<option value="${k}" ${f.kind === k ? "selected" : ""}>${l}</option>`)}</select></div>
        <div class="field"><label for="tl-from">From</label><input id="tl-from" name="from" type="datetime-local" value="${f.from ? toLocalInput(f.from) : ""}"></div>
        <div class="field"><label for="tl-to">To</label><input id="tl-to" name="to" type="datetime-local" value="${f.to ? toLocalInput(f.to) : ""}"></div>
        <div class="row"><button class="btn btn-dark btn-sm">Show</button><a class="btn btn-ghost btn-sm" href="${url}?${q}" download>Download CSV</a></div></form>
      ${r.items.length ? html`<div class="team-act mt"><div class="table-wrap"><table><thead><tr><th>Time</th><th>What</th><th>Gate or detail</th><th class="num">Amount</th><th>Reference</th></tr></thead><tbody>
        ${r.items.map((i) => html`<tr data-kind="${i.kind}" data-action="${i.action}"><td data-label="Time"><span>${fmtDateTime(i.at)}</span></td>
          <td data-label="What"><span>${actionLabel(i)}${i.offline ? html` <span class="badge plain">Offline</span><span class="tiny muted">Sent ${fmtTime(i.syncedAt)}</span>` : ""}</span></td>
          <td data-label="Gate or detail"><span>${[i.place, i.kind === "box_office" && i.action === "sale" && i.detail ? plural(i.detail, "ticket") : i.kind === "topup" && i.action === "topup" ? (i.detail === "confirmed" ? "" : `Later ${i.detail}`) : i.action === "shift_closed" ? (i.detail !== null ? `Difference ${moneyExact(i.detail)}` : "") : i.detail].filter(Boolean).join(" · ")}</span></td>
          <td class="num" data-label="Amount"><span>${i.amountCents === null ? "" : `${moneyExact(i.amountCents)}${i.method ? ` ${METHODS[i.method] || i.method}` : ""}`}</span></td>
          <td data-label="Reference"><span class="mono small">${i.reference || ""}</span></td></tr>`)}</tbody></table></div></div>` : empty("Nothing for these filters.")}`);
    onSubmit($("[data-tl-filter]", box), async (v) => { f.kind = v.kind || ""; f.from = v.from ? fromLocalInput(v.from) : ""; f.to = v.to ? fromLocalInput(v.to) : ""; await draw(); });
  };
  try { await draw(); } catch (err) { render(box, html`<p class="callout warn">${err.message}</p>`); }
}
