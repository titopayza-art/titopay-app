import { appConfig, html, raw, render, $, $$, get, post, del, money, moneyExact, fmtDate, fmtTime, fmtDateTime, dayNum, monShort, header, footer, poster, requireUser, authDialog, me, toast, onSubmit, idem, badge, empty, spinner, esc, siteInfo, callbackFields, callbackDialog, hoursText, weekTable, features, subscribeForm, pageReady, likeButton, shareBar, svgIcon, INSTAGRAM, X_SOCIAL, FACEBOOK_SOCIAL, calendarFile, AGE_GROUPS, TICKET_KINDS, ageGroupText, ticketPng, organiserSignupDialog, dialog, consent } from "/assets/core.js?build=2026-10-22-phases";
import { documents, ORDER, VERSION, EFFECTIVE } from "/assets/legal.js?build=2026-10-22-phases";

const main = $("#main");
const CATS = [["", "All"], ["music", "Music"], ["festival", "Festivals"], ["comedy", "Comedy"], ["sport", "Sport"], ["arts", "Arts & theatre"], ["food", "Food & drink"], ["family", "Family"], ["business", "Business"], ["nightlife", "Nightlife"]];

const datebadge = (d) => html`<div class="datebadge"><b>${dayNum(d)}</b><span>${monShort(d)}</span></div>`;
const fromPrice = (e) => e.from_price_cents === null ? "" : e.from_price_cents === 0 ? html`<span class="price">Free</span>` : html`<span class="price"><small>From </small>${money(e.from_price_cents)}</span>`;

function card(e) {
  return html`<a class="event-card" href="/events/${e.slug}">
    <div class="poster">${poster(e, "fill")}${datebadge(e.starts_at)}${e.cashless_enabled ? html`<span class="cashless-flag" title="Cashless event"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M9 7.5a6.5 6.5 0 0 1 0 9M12.5 5a10 10 0 0 1 0 14M5.5 10a2.8 2.8 0 0 1 0 4"/></svg>Cashless</span>` : ""}${e.remaining === 0 ? html`<span class="badge bad sold-flag">Sold out</span>` : e.remaining < 30 ? html`<span class="badge amber sold-flag">Selling fast</span>` : ""}</div>
    <div class="body"><span class="cat-label">${e.category}</span><h3>${e.title}</h3>
      <span class="muted small">${fmtDate(e.starts_at, { weekday: "short", day: "numeric", month: "short" })} · ${fmtTime(e.starts_at)}</span>
      <span class="muted small">${e.venue_name}, ${e.city}${e.distance_km != null ? html` · <strong class="dist">${e.distance_km < 1 ? "under 1" : e.distance_km} km away</strong>` : ""}</span>
      <div class="foot">${fromPrice(e)}<span class="small muted">${e.likes ? html`<span class="likes-count" aria-label="${e.likes} likes">${svgIcon("heart", 14)} ${e.likes}</span> · ` : ""}${e.organiser_name}</span></div></div></a>`;
}

// Small line icons (stroke follows the text colour).
const ICONS = {
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4Z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  cart: '<path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6"/><circle cx="10" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/>',
};
const icon = (name) => raw(`<svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);

// ---------------- home / discovery ----------------
// Event filters: what the URL carries and how each one is described in a chip.
const FILTER_KEYS = ["q", "categories", "city", "when", "from", "to", "free", "minPrice", "maxPrice", "near", "nearLabel", "km", "age", "cashless"];
const WHEN = [["", "Any date"], ["today", "Today"], ["tomorrow", "Tomorrow"], ["weekend", "This weekend"], ["week", "Next 7 days"], ["month", "Next 30 days"]];
const PRICES = [["", "", "Any price"], ["free", "", "Free"], ["0", "100", "Under R100"], ["100", "300", "R100 to R300"], ["300", "", "R300 and up"]];
const DISTANCES = [10, 25, 50, 100, 200];
const TOWNS = ["Johannesburg", "Pretoria", "Soweto", "Sandton", "Midrand", "Centurion", "Cape Town", "Stellenbosch", "Paarl", "George", "Knysna", "Durban", "Umhlanga", "Pietermaritzburg", "Ballito", "Gqeberha", "East London", "Bloemfontein", "Polokwane", "Mbombela", "Rustenburg", "Potchefstroom", "Kimberley", "Mthatha", "Richards Bay", "Hermanus", "Mahikeng", "Emalahleni"];
const catName = (k) => (CATS.find(([v]) => v === k) || [k, k])[1];
const randText = (v) => `R${Number(v).toLocaleString("en-ZA")}`;

function filterChips(state) {
  const out = [];
  for (const c of (state.categories || "").split(",").filter(Boolean)) out.push([`cat:${c}`, catName(c)]);
  if (state.near) out.push(["near", `${state.km ? `Within ${state.km} km of ` : "Near "}${state.nearLabel || "you"}`]);
  if (state.city) out.push(["city", state.city]);
  if (state.when) out.push(["when", (WHEN.find(([v]) => v === state.when) || [, state.when])[1]]);
  if (state.from || state.to) out.push(["dates", `${state.from ? fmtDate(`${state.from}T12:00:00+02:00`, { day: "numeric", month: "short" }) : "Now"} to ${state.to ? fmtDate(`${state.to}T12:00:00+02:00`, { day: "numeric", month: "short" }) : "later"}`]);
  if (state.free) out.push(["free", "Free"]);
  if (state.minPrice || state.maxPrice) out.push(["price", state.minPrice && state.maxPrice ? `${randText(state.minPrice)} to ${randText(state.maxPrice)}` : state.maxPrice ? `Under ${randText(state.maxPrice)}` : `${randText(state.minPrice)} and up`]);
  if (state.age) out.push(["age", AGE_GROUPS[state.age]]);
  if (state.cashless) out.push(["cashless", "Cashless events"]);
  return out;
}
function dropFilter(state, key) {
  if (key.startsWith("cat:")) state.categories = state.categories.split(",").filter((c) => c && c !== key.slice(4)).join(",");
  else if (key === "near") Object.assign(state, { near: "", nearLabel: "", km: "" });
  else if (key === "dates") Object.assign(state, { from: "", to: "" });
  else if (key === "price") Object.assign(state, { minPrice: "", maxPrice: "" });
  else state[key] = "";
}
const filterQuery = (st) => new URLSearchParams(Object.entries(st).filter(([k, v]) => v && k !== "nearLabel")).toString();

// The Filters sheet: everything in one place, with a live count on the button.
function filtersSheet(state, apply) {
  const f = { ...state };
  const d = dialog("Filters", html`<form class="filters" novalidate>
    <section><h3>Where</h3>
      <div class="seg" role="radiogroup" aria-label="Where">
        <label><input type="radio" name="where" value="any" ${raw(!f.near ? "checked" : "")}><span>Anywhere</span></label>
        <label><input type="radio" name="where" value="me" ${raw(f.near && !TOWNS.includes(f.nearLabel) ? "checked" : "")}><span>Near me</span></label>
        <label><input type="radio" name="where" value="town" ${raw(f.near && TOWNS.includes(f.nearLabel) ? "checked" : "")}><span>Pick a town</span></label></div>
      <div class="field" data-town hidden><label for="fl-town">Town or city</label><select id="fl-town">${TOWNS.map((t) => html`<option ${raw(f.nearLabel === t ? "selected" : "")}>${t}</option>`)}</select></div>
      <p class="small muted mb-0" data-where-note></p>
      <div data-km hidden><span class="label">How far?</span><div class="fpills">${DISTANCES.map((k) => html`<button type="button" class="fpill" data-kmv="${k}" aria-pressed="${String(Number(f.km) === k)}">${k} km</button>`)}<button type="button" class="fpill" data-kmv="" aria-pressed="${String(!f.km)}">Any distance</button></div></div></section>
    <section><h3>What</h3><div class="fpills">${CATS.filter(([v]) => v).map(([v, l]) => html`<button type="button" class="fpill" data-catv="${v}" aria-pressed="${String((f.categories || "").split(",").includes(v))}">${l}</button>`)}</div></section>
    <section><h3>When</h3><div class="fpills">${WHEN.map(([v, l]) => html`<button type="button" class="fpill" data-whenv="${v}" aria-pressed="${String((f.when || "") === v && !f.from && !f.to)}">${l}</button>`)}</div>
      <div class="grid-2 mt"><div class="field"><label for="fl-from">From</label><input id="fl-from" type="date" value="${f.from || ""}"></div><div class="field"><label for="fl-to">To</label><input id="fl-to" type="date" value="${f.to || ""}"></div></div></section>
    <section><h3>Price</h3><div class="fpills">${PRICES.map(([lo, hi, l]) => html`<button type="button" class="fpill" data-price="${lo}|${hi}" aria-pressed="${String(lo === "free" ? !!f.free : !f.free && (f.minPrice || "") === (lo === "0" ? "" : lo) && (f.maxPrice || "") === hi && (lo !== "" || (!f.minPrice && !f.maxPrice)))}">${l}</button>`)}</div>
      <div class="grid-2 mt"><div class="field"><label for="fl-min">Min (R)</label><input id="fl-min" type="number" min="0" inputmode="numeric" value="${f.minPrice || ""}" placeholder="0"></div><div class="field"><label for="fl-max">Max (R)</label><input id="fl-max" type="number" min="0" inputmode="numeric" value="${f.maxPrice || ""}" placeholder="No limit"></div></div></section>
    <section><h3>Who it's for</h3><div class="fpills"><button type="button" class="fpill" data-agev="" aria-pressed="${String(!f.age)}">Everyone</button>${Object.entries(AGE_GROUPS).filter(([k]) => k !== "all").map(([k, l]) => html`<button type="button" class="fpill" data-agev="${k}" aria-pressed="${String(f.age === k)}">${l}</button>`)}</div></section>
    <div class="filters-foot"><button type="button" class="btn btn-ghost" data-clear>Clear all</button><button type="submit" class="btn btn-primary grow" data-show>Show events</button></div></form>`, { wide: true });
  const form = $("form", d);
  const press = (sel, on) => $$(sel, d).forEach((b) => b.setAttribute("aria-pressed", String(on(b))));
  let timer;
  const count = () => {
    clearTimeout(timer);
    $("[data-show]", d).setAttribute("aria-busy", "true");
    timer = setTimeout(async () => {
      try {
        const r = await get(`/api/public/events?${filterQuery(f)}`);
        $("[data-show]", d).textContent = r.total ? `Show ${r.total} event${r.total === 1 ? "" : "s"}` : "No events match yet";
        $("[data-show]", d).disabled = !r.total;
      } catch { $("[data-show]", d).textContent = "Show events"; }
      $("[data-show]", d).removeAttribute("aria-busy");
    }, 250);
  };
  const where = () => {
    const w = form.elements.where.value;
    $("[data-town]", d).hidden = w !== "town";
    $("[data-km]", d).hidden = w === "any";
    $("[data-where-note]", d).textContent = w === "me" ? (f.near ? `Using your location${f.nearLabel ? `, near ${f.nearLabel}` : ""}.` : "") : "";
  };
  form.elements.where.forEach((r) => r.addEventListener("change", () => {
    const w = form.elements.where.value;
    if (w === "any") Object.assign(f, { near: "", nearLabel: "", km: "" });
    if (w === "town") Object.assign(f, { near: $("#fl-town", d).value, nearLabel: $("#fl-town", d).value, km: f.km || "50" });
    if (w === "me") {
      $("[data-where-note]", d).textContent = "Finding you…";
      if (!navigator.geolocation) { toast("Your browser can't share its location. Pick a town instead.", "bad"); form.elements.where.value = "town"; f.near = $("#fl-town", d).value; f.nearLabel = f.near; where(); count(); return; }
      navigator.geolocation.getCurrentPosition(async (pos) => {
        f.near = `${pos.coords.latitude.toFixed(3)},${pos.coords.longitude.toFixed(3)}`; f.km = f.km || "50";
        try { f.nearLabel = (await get(`/api/public/events?near=${f.near}&km=1`)).near || ""; } catch { f.nearLabel = ""; }
        press("[data-kmv]", (b) => b.dataset.kmv === f.km); where(); count();
      }, () => { toast("We couldn't get your location. Pick a town instead.", "bad"); form.elements.where.value = "town"; f.near = $("#fl-town", d).value; f.nearLabel = f.near; f.km = f.km || "50"; where(); count(); }, { timeout: 8000, maximumAge: 600000 });
    }
    press("[data-kmv]", (b) => b.dataset.kmv === (f.km || "")); where(); count();
  }));
  $("#fl-town", d).addEventListener("change", (e) => { f.near = e.target.value; f.nearLabel = e.target.value; count(); });
  $$("[data-kmv]", d).forEach((b) => b.addEventListener("click", () => { f.km = b.dataset.kmv; press("[data-kmv]", (x) => x === b); count(); }));
  $$("[data-catv]", d).forEach((b) => b.addEventListener("click", () => {
    const set = new Set((f.categories || "").split(",").filter(Boolean));
    set.has(b.dataset.catv) ? set.delete(b.dataset.catv) : set.add(b.dataset.catv);
    f.categories = [...set].join(","); b.setAttribute("aria-pressed", String(set.has(b.dataset.catv))); count();
  }));
  $$("[data-whenv]", d).forEach((b) => b.addEventListener("click", () => { f.when = b.dataset.whenv; f.from = ""; f.to = ""; $("#fl-from", d).value = ""; $("#fl-to", d).value = ""; press("[data-whenv]", (x) => x === b); count(); }));
  for (const id of ["fl-from", "fl-to"]) $(`#${id}`, d).addEventListener("change", () => { f.from = $("#fl-from", d).value; f.to = $("#fl-to", d).value; if (f.from || f.to) { f.when = ""; press("[data-whenv]", () => false); } count(); });
  $$("[data-price]", d).forEach((b) => b.addEventListener("click", () => {
    const [lo, hi] = b.dataset.price.split("|");
    Object.assign(f, lo === "free" ? { free: "1", minPrice: "", maxPrice: "" } : { free: "", minPrice: lo === "0" ? "" : lo, maxPrice: hi });
    $("#fl-min", d).value = f.minPrice; $("#fl-max", d).value = f.maxPrice; press("[data-price]", (x) => x === b); count();
  }));
  for (const id of ["fl-min", "fl-max"]) $(`#${id}`, d).addEventListener("input", () => { f.minPrice = $("#fl-min", d).value; f.maxPrice = $("#fl-max", d).value; f.free = ""; press("[data-price]", () => false); count(); });
  $$("[data-agev]", d).forEach((b) => b.addEventListener("click", () => { f.age = b.dataset.agev; press("[data-agev]", (x) => x === b); count(); }));
  $("[data-clear]", d).addEventListener("click", () => { d.close(); for (const k of FILTER_KEYS) if (k !== "q") state[k] = ""; apply(); });
  form.addEventListener("submit", (e) => { e.preventDefault(); Object.assign(state, f); d.close(); apply(); });
  where(); count();
}

async function home() {
  document.title = "TicketRoom | Event tickets in South Africa";
  const params = new URLSearchParams(location.search);
  const state = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || ""]));
  if (!state.categories && params.get("category")) state.categories = params.get("category");
  if (state.near && !state.nearLabel && !/^-?\d/.test(state.near)) state.nearLabel = state.near;
  render(main, html`
    <section class="hero"><div class="wrap">
      <h1>Your event. <b>Your ticket.</b></h1>
      <p class="lead">Concerts, comedy, sport and festivals across South Africa. Book in a minute, keep your tickets on your phone, and pass them to a friend if plans change.</p>
      <form class="search" role="search" id="search"><label class="sr-only" for="q">Search events</label>
        <input id="q" name="q" placeholder="Search events, artists, venues or cities" value="${state.q}" autocomplete="off">
        <label class="sr-only" for="city">City</label><select id="city" name="city"><option value="">All cities</option></select>
        <button class="btn btn-primary">Search</button></form>
      <div class="feature-rail" id="featured" aria-label="Featured events" hidden></div>
    </div></section>
    <section class="section pt-0 hidden" id="recently-viewed"><div class="wrap"><div class="row between"><h2 class="mb-0">Recently viewed</h2><button type="button" class="btn btn-link small" data-clear-recent>Clear history</button></div><div class="event-grid mt" id="recently-viewed-grid"></div></div></section>
    <section class="section"><div class="wrap">
      <div class="row between events-head"><h2 class="mb-0">Upcoming events</h2>
        <button type="button" class="btn btn-ghost filter-btn" data-filters><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Filters<span class="filter-count" data-fcount hidden></span></button></div>
      <div class="chips mt" role="group" aria-label="Quick filters">${[["today", "Today"], ["weekend", "This weekend"], ["week", "Next 7 days"]].map(([v, l]) => html`<button class="chip" data-when="${v}" aria-pressed="${state.when === v}">${l}</button>`)}<button class="chip" data-free aria-pressed="${state.free === "1"}">Free</button>${CATS.filter(([v]) => v).slice(0, 5).map(([v, l]) => html`<button class="chip" data-cat="${v}" aria-pressed="${state.categories.split(",").includes(v)}">${l}</button>`)}</div>
      <div class="active-filters mt" data-active aria-live="polite"></div>
      <div class="event-grid mt" id="grid" aria-live="polite">${spinner()}</div>
      <p class="muted small mt" data-result-count aria-live="polite"></p>
      <div class="center mt" data-more-wrap hidden><button type="button" class="btn btn-ghost" data-more>Show more events</button></div>
    </div></section>
    <section class="section pt-0 hidden" id="ads-events"><div class="wrap"><div class="row between"><div><span class="cat-label">Sponsored</span><h2 class="mb-0">Featured for event-goers</h2></div><a class="small" href="/advertise">Advertise with us</a></div><div class="poster-rail mt" id="ad-events-rail"></div></div></section>
    <section class="section pt-0 hidden" id="cashless"><div class="wrap"><div class="cashless-home">
      <div class="cashless-intro"><span class="cat-label">Cashless events</span><h2>Tap to pay. No cash, no queues.</h2>
        <p>At these events your wristband is your wallet. Top up on your phone, tap at the bar and food stalls, and get back what you don't spend.</p>
        <a class="btn btn-dark btn-sm" href="/?cashless=1#grid" data-cl-all>See all cashless events</a></div>
      <div class="cashless-rail" id="cashless-rail"></div></div></div></section>
    <section class="section pt-0 hidden" id="trending"><div class="wrap"><h2>Trending artists</h2><div class="artist-rail mt" id="artist-rail"></div></div></section>
    <section class="section hidden" id="ads"><div class="wrap"><div class="row between"><h2 class="mb-0">Featured</h2><a class="small" href="/advertise">Advertise with us</a></div><div class="poster-rail mt" id="ad-rail"></div></div></section>
    <section class="section"><div class="wrap"><div class="promo-band">
      <div><span class="cat-label">For organisers</span><h2>Putting on an event? List it with us.</h2>
        <ul><li>QR tickets and a live view of who has booked</li><li>Your staff scan tickets at the gate on their own phones</li><li>Email the people who asked to hear from you</li><li>Cashless wristbands, vendor POS and transparent payouts</li><li>Free events cost nothing to list</li></ul></div>
      <div class="promo-actions"><div class="row"><a class="btn btn-primary" href="/sell">Start selling</a><a class="btn btn-outline-light" href="/organisers">Organiser login</a></div>
        <a class="promo-partner" href="/partners">Planning an event or representing a venue or brand? <span>Partner with us <span aria-hidden="true">→</span></span></a></div>
    </div></div></section>
    <section class="section pt-0"><div class="wrap"><div class="ad-band">
      <div><span class="cat-label">Advertising</span><h2>Advertise your business on TicketRoom</h2>
        <p class="mb-0">Get a spot from <strong data-advert-price>R50</strong> per day. Your poster sits in front of people planning their next night out.</p></div>
      <a class="btn btn-primary" href="/advertise">Get a spot</a>
    </div></div></section>
    <section class="section pt-0"><div class="wrap"><a class="safety-teaser" href="/safety">
      <span class="safety-teaser-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></svg></span>
      <span class="safety-teaser-copy"><span class="cat-label">Before you head out</span><strong>Event safety</strong><span>Simple ways to look after yourself and your friends.</span></span>
      <span class="safety-teaser-link">Read the guide <span aria-hidden="true">→</span></span>
    </a></div></section>`);

  const syncQuick = () => {
    $$("[data-when]").forEach((x) => x.setAttribute("aria-pressed", String(state.when === x.dataset.when && !state.from && !state.to)));
    $("[data-free]").setAttribute("aria-pressed", String(!!state.free));
    $$("[data-cat]").forEach((x) => x.setAttribute("aria-pressed", String(state.categories.split(",").includes(x.dataset.cat))));
    const chips = filterChips(state).filter(([k]) => k !== "city");
    const n = chips.length;
    $("[data-fcount]").hidden = !n; $("[data-fcount]").textContent = String(n);
    render($("[data-active]"), chips.length ? html`${chips.map(([k, l]) => html`<button type="button" class="active-chip" data-drop="${k}" aria-label="Remove filter: ${l}">${l}<span aria-hidden="true">×</span></button>`)}<button type="button" class="btn-link small" data-drop-all>Clear all</button>` : "");
    $$("[data-drop]").forEach((b) => b.addEventListener("click", () => { dropFilter(state, b.dataset.drop); load(); }));
    $("[data-drop-all]")?.addEventListener("click", () => { for (const k of FILTER_KEYS) if (k !== "q") state[k] = ""; $("#city").value = ""; load(); });
  };
  let eventOffset = 0;
  let loadSequence = 0;
  const load = async (append = false) => {
    if (!append) eventOffset = 0;
    const offset = append ? eventOffset : 0;
    const sequence = ++loadSequence;
    const qs = new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString();
    history.replaceState(null, "", qs ? `/?${qs}` : "/");
    syncQuick();
    const query = new URLSearchParams(filterQuery(state));
    if (offset) query.set("offset", String(offset));
    const moreButton = $("[data-more]");
    moreButton.disabled = false; moreButton.textContent = "Show more events";
    if (append) { moreButton.disabled = true; moreButton.textContent = "Loading…"; }
    try {
    const { events, cities, total } = await get(`/api/public/events?${query}`);
    if (sequence !== loadSequence) return;
    const sel = $("#city");
    if (sel.options.length === 1) cities.forEach((c) => { const o = new Option(`${c.city} (${c.n})`, c.city); sel.add(o); });
    sel.value = state.city;
    if (append) {
      const chunk = document.createElement("div");
      render(chunk, html`${events.map(card)}`);
      $("#grid").append(...chunk.childNodes);
    } else {
      render($("#grid"), events.length ? html`${events.map(card)}` : html`<div class="empty-filters card flat center"><h3>No events match those filters</h3><p class="muted">Try a wider distance, other dates, or fewer filters.</p><button type="button" class="btn btn-primary" data-filters-again>Change filters</button></div>`);
    }
    eventOffset = offset + events.length;
    $("[data-result-count]").textContent = total ? `Showing ${eventOffset} of ${total} events` : "";
    $("[data-more-wrap]").hidden = eventOffset >= total || events.length === 0;
    moreButton.disabled = false; moreButton.textContent = "Show more events";
    $("[data-filters-again]")?.addEventListener("click", () => filtersSheet(state, load));
    if (!append && !filterChips(state).length && !state.q) {
      const feat = events.filter((e) => e.featured).slice(0, 6);
      $("#featured").hidden = !feat.length;
      render($("#featured"), html`${feat.map((e) => html`<a class="feature" href="/events/${e.slug}">${poster(e)}<span class="shade"></span><div class="meta"><span class="badge amber plain">${fmtDate(e.starts_at, { weekday: "short", day: "numeric", month: "short" })}</span><h3>${e.title}</h3><span class="small">${e.venue_name}, ${e.city} · ${e.from_price_cents === 0 ? "Free" : `from ${money(e.from_price_cents)}`}</span></div></a>`)}`);
    } else if (!append) { $("#featured").hidden = true; render($("#featured"), ""); }
    } catch (err) {
      if (sequence !== loadSequence) return;
      moreButton.disabled = false; moreButton.textContent = "Show more events";
      if (append) toast("We couldn’t load more events. Please try again.", "bad");
      else render($("#grid"), html`<div class="empty-filters card flat center"><h3>We couldn't load events</h3><p class="muted">Check your connection and try again.</p><button type="button" class="btn btn-primary" data-retry>Try again</button></div>`);
      $("[data-retry]")?.addEventListener("click", () => load());
      console.warn("Event discovery request failed", err);
    }
  };
  $("[data-more]").addEventListener("click", () => load(true));
  $("#search").addEventListener("submit", (e) => { e.preventDefault(); state.q = $("#q").value.trim(); state.city = $("#city").value; load(); });
  $("[data-filters]").addEventListener("click", () => filtersSheet(state, load));
  $$("[data-cat]").forEach((b) => b.addEventListener("click", () => {
    const set = new Set(state.categories.split(",").filter(Boolean));
    set.has(b.dataset.cat) ? set.delete(b.dataset.cat) : set.add(b.dataset.cat);
    state.categories = [...set].join(","); load();
  }));
  $("[data-free]").addEventListener("click", () => { state.free = state.free ? "" : "1"; if (state.free) { state.minPrice = ""; state.maxPrice = ""; } load(); });
  $$("[data-when]").forEach((b) => b.addEventListener("click", () => { state.when = state.when === b.dataset.when ? "" : b.dataset.when; state.from = ""; state.to = ""; load(); }));
  const showAds = (site) => {
    const ads = site?.posters || [];
    const placements = [["home", "#ads", "#ad-rail"], ["events", "#ads-events", "#ad-events-rail"]];
    for (const [placement, section, rail] of placements) {
      const group = ads.filter((a) => (a.placement || "home") === placement);
      if (!group.length) continue;
      $(section).classList.remove("hidden");
      render($(rail), html`${group.map((a) => html`<a class="ad-poster" href="${a.link_url || "#"}" data-ad="${a.id}" ${raw(/^https?:/i.test(a.link_url || "") ? 'target="_blank" rel="noopener sponsored"' : "")}>
      ${a.image_upload_id ? html`<img src="/media/${a.image_upload_id}" alt="${a.title}" loading="lazy">` : ""}<span class="sponsored">Featured</span>
      <div class="meta"><h3>${a.title}</h3>${a.subtitle ? html`<span>${a.subtitle}</span>` : ""}</div></a>`)}`);
    }
    $$("[data-ad]").forEach((a) => a.addEventListener("click", () => { navigator.sendBeacon?.(`/api/site/posters/${a.dataset.ad}/click`) || post(`/api/site/posters/${a.dataset.ad}/click`).catch(() => {}); }));
  };
  // Cashless events get their own band on the home page.
  get("/api/public/events?cashless=1").then(({ events }) => {
    if (!events.length) return;
    $("#cashless").classList.remove("hidden");
    render($("#cashless-rail"), html`${events.slice(0, 8).map(card)}`);
    $("[data-cl-all]").addEventListener("click", (ev) => { ev.preventDefault(); for (const k of FILTER_KEYS) if (k !== "q") state[k] = ""; state.cashless = "1"; load(); $("#grid").scrollIntoView({ behavior: "smooth", block: "start" }); });
  }).catch(() => {});
  // Trending artists: acts on upcoming events, ranked by recent sales and likes.
  get("/api/public/artists/trending").then(({ artists }) => {
    if (!artists.length) return;
    $("#trending").classList.remove("hidden");
    const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    render($("#artist-rail"), html`${artists.map((a) => html`<button type="button" class="artist" data-artist="${a.name}">
      <span class="artist-pic">${a.next.image_upload_id ? html`<img src="/media/${a.next.image_upload_id}" alt="" loading="lazy">` : html`<span>${initials(a.name)}</span>`}</span>
      <strong>${a.name}</strong><span class="small muted">${a.eventCount > 1 ? `${a.eventCount} events` : `${fmtDate(a.next.starts_at, { day: "numeric", month: "short" })}, ${a.next.city}`}</span></button>`)}`);
    $$("[data-artist]").forEach((b) => b.addEventListener("click", () => { state.q = b.dataset.artist; $("#q").value = state.q; load(); $("#grid").scrollIntoView({ behavior: "smooth", block: "start" }); }));
  }).catch(() => {});
  showAds(await siteInfo());
  appConfig().then((c) => { const price = c.fees?.advertisingDailyPriceCents; if (Number.isInteger(price)) $$('[data-advert-price]').forEach((x) => { x.textContent = moneyExact(price).replace(/\.00$/, ""); }); });
  (async () => {
    try {
      const u = await me();
      if (!u || (u.account_type || "customer") !== "customer") return;
      const { events } = await get("/api/public/recently-viewed");
      if (!events.length) return;
      $("#recently-viewed").classList.remove("hidden");
      render($("#recently-viewed-grid"), html`${events.map(card)}`);
      $("[data-clear-recent]").addEventListener("click", async () => { try { await del("/api/public/recently-viewed"); $("#recently-viewed").classList.add("hidden"); render($("#recently-viewed-grid"), ""); toast("Recently viewed history cleared.", "good"); } catch { toast("We couldn’t clear your history. Try again.", "bad"); } });
    } catch { /* Recent history is an optional customer convenience. */ }
  })();
  await load();
}

// ---------------- event page + checkout ----------------
async function eventPage(slug, opts = {}) {
  // Two views of one event: the event page (/events/x) and its ticket page (/events/x/tickets).
  const ticketsMode = !!opts.tickets;
  const ticketsUrl = `/events/${encodeURIComponent(slug)}/tickets${location.search}`;
  const eventHref = `/events/${encodeURIComponent(slug)}${location.search}`;
  // Old links into the ticket box (waitlist offers, "#box") now open the ticket page.
  if (!ticketsMode) { const q0 = new URLSearchParams(location.search); if (q0.get("offer") || q0.get("leave") || location.hash === "#box") { location.replace(ticketsUrl); return; } }
  const pv = new URLSearchParams(location.search).get("preview");
  const [{ event: e, ticketTypes }, cfg] = await Promise.all([get(`/api/public/events/${encodeURIComponent(slug)}${pv ? `?preview=${encodeURIComponent(pv)}` : ""}`), get("/api/config")]);
  // Previews are private: keep them out of search engines.
  if (e.preview) { const m = document.createElement("meta"); m.name = "robots"; m.content = "noindex"; document.head.append(m); }
  document.title = `${e.title} | TicketRoom`;
  if (!ticketsMode && !e.preview && e.status === "published") post(`/api/public/events/${encodeURIComponent(slug)}/view`, {}).catch(() => {});
  const ref = new URLSearchParams(location.search).get("ref");
  // Keep retailer attribution for this event through the buyer's current
  // browsing session, even if they leave the event page before checkout.
  const retailerRef = new URLSearchParams(location.search).get("retailer");
  if (retailerRef && /^RP-[A-Z0-9]{8}$/i.test(retailerRef)) {
    try { sessionStorage.setItem(`tr_retail_${slug}`, retailerRef); } catch { /* private mode */ }
  }
  // The organiser link that brought the buyer here: kept for later visits only with functional consent.
  if (ref) { if (consent("functional")) { try { sessionStorage.setItem(`tr_ref_${slug}`, ref); } catch { /* private mode */ } } post(`/api/public/events/${slug}/click`, { ref }).catch(() => {}); }
  const qty = Object.fromEntries(ticketTypes.map((t) => [t.id, 0]));
  const closed = !e.salesOpen;
  const lineup = Array.isArray(e.lineup) ? e.lineup : [];
  const place = [e.venue_name, e.address, e.city, e.province].filter(Boolean).join(", ");
  const mapDestination = encodeURIComponent(place);
  const mapUrl = `https://www.google.com/maps/dir/?api=1&destination=${mapDestination}`;
  const day = (d) => fmtDate(d, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  // Phases: only ticket types whose turn it is can be bought (on_sale); others are next, scheduled or ended.
  const buyable = (t) => (t.release_state || "on_sale") === "on_sale";
  const forSale = ticketTypes.filter((t) => t.remaining > 0 && buyable(t));
  const fromCents = ticketTypes.length ? Math.min(...(forSale.length ? forSale : ticketTypes).map((t) => t.price_cents)) : null;
  const buyLabel = e.is_free ? "Get free tickets" : "Buy tickets";
  const initials = (s) => String(s || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const dateLine = html`${day(e.starts_at)}${dayNum(e.starts_at) === dayNum(e.ends_at) && monShort(e.starts_at) === monShort(e.ends_at) ? "" : ` to ${day(e.ends_at)}`}`;
  const previewBar = e.preview ? html`<div class="preview-bar" role="note"><div class="wrap row between"><span><strong>Preview.</strong> Only people with this link can see this page. Tickets go on sale once it is published.</span>
      ${e.previewOrganiserId ? html`<a class="btn btn-sm btn-primary" href="/organisers#/events/${e.id}">Back to publish</a>` : ""}</div></div>` : "";
  const eventUrl = `${location.origin}/events/${e.slug}`;

  if (ticketsMode) {
    document.title = `Tickets: ${e.title} | TicketRoom`;
    render(main, html`${previewBar}
      <section class="tix-head">${poster(e, "fill")}<span class="shade"></span><div class="wrap">
        <a class="tix-back" href="${eventHref}">${icon("back")}Event details</a>
        <div class="row between tix-head-row"><div><h1>${e.title}</h1><p class="mb-0">${dateLine} · ${fmtTime(e.starts_at)} · ${e.venue_name}, ${e.city}</p></div>
          <a class="btn btn-ghost btn-sm tix-cancel" href="${eventHref}">Cancel</a></div></div></section>
      <div class="wrap tix-page">
        <ol class="tix-steps" aria-label="Checkout steps">
          <li data-step="0">${icon("ticket")}<span>Select tickets</span></li>
          <li data-step="1">${icon("user")}<span>Your details</span></li>
          <li data-step="2">${icon("card")}<span>Pay</span></li>
          <li data-step="3">${icon("check")}<span>Done</span></li></ol>
        ${e.status === "cancelled" ? html`<p class="callout bad"><strong>This event has been cancelled.</strong> Ticket holders are refunded automatically.</p>` : ""}
        <div id="box" class="tix-box" aria-labelledby="tix-h"></div>
      </div>`);
  } else {
    const info = [
      e.age_restriction ? ["Age requirement", /^\d+$/.test(String(e.age_restriction)) ? `${e.age_restriction}+ only` : e.age_restriction] : null,
      e.age_groups ? ["Made for", ageGroupText(e.age_groups)] : null,
      e.doors_open_at ? ["Doors open", `${fmtTime(e.doors_open_at)} SAST`] : null,
      e.park_ride_info || e.park_ride_url ? ["Parking & transport", html`${e.park_ride_info ? html`<span class="prose">${e.park_ride_info}</span>` : ""}${e.park_ride_url ? html` <a href="${e.park_ride_url}" target="_blank" rel="noopener noreferrer">Parking and shuttle details</a>` : ""}`] : null,
      e.prohibited_items ? ["Prohibited items", html`<span class="prose">${e.prohibited_items}</span>`] : null,
      e.accessibility_info ? ["Accessibility", html`<span class="prose">${e.accessibility_info}</span>`] : null,
      ["Ticket transfers", e.transfers_enabled ? "Free ticket transfers until the event starts" : "Tickets are not transferable"],
      e.cashless_enabled ? ["Cashless", "This is a cashless event. Link a wristband and top up in your account."] : null,
      ["Refund policy", html`${e.refund_policy} <a class="ev-more" href="/legal/terms">View policy</a>`],
    ].filter(Boolean);
    render(main, html`${previewBar}
      <div class="ev2">
        <div class="wrap ev2-top">
          <div class="ev2-banner">${e.image_upload_id ? html`<img class="ev2-banner-bg" src="/media/${e.image_upload_id}" alt=""><img class="ev2-banner-img" src="/media/${e.image_upload_id}" alt="${e.title} poster">` : poster(e, "fill")}</div>
          <section class="ev2-title card">
            <span class="cat-badge">${e.category}</span><h1>${e.title}</h1>
            ${e.summary ? html`<p class="lead">${e.summary}</p>` : ""}
            <div class="event-facts"><span>${icon("calendar")}${dateLine}</span>
              <span>${icon("clock")}${fmtTime(e.starts_at)} to ${fmtTime(e.ends_at)} SAST${e.doors_open_at ? ` · doors ${fmtTime(e.doors_open_at)}` : ""}</span>
              <a class="event-place" href="${mapUrl}" target="_blank" rel="noopener noreferrer" aria-label="Directions to ${place} in Google Maps">${icon("pin")}${place}</a></div>
            <div class="ev2-cta"><a class="btn btn-primary btn-lg" href="${ticketsUrl}" data-buy>${buyLabel}</a>
              ${fromCents !== null && !e.is_free ? html`<span class="ev2-from">${fromCents === 0 ? "Free" : html`From <strong>${money(fromCents)}</strong>`}</span>` : ""}</div>
            <div class="event-actions" data-actions></div>
            ${e.cashless_enabled ? html`<div class="cashless-note" role="note"><div class="cl-head"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 7.5a6.5 6.5 0 0 1 0 9M12.5 5a10 10 0 0 1 0 14M5.5 10a2.8 2.8 0 0 1 0 4"/></svg>
              <strong>This event is cashless</strong></div><p class="mb-0">No cash at the bars and food stalls. Tap your wristband to pay and top up on your phone.</p>
              <button type="button" class="btn cl-more" data-cashless>More info</button></div>` : ""}
            ${e.status === "cancelled" ? html`<p class="callout bad mt mb-0"><strong>This event has been cancelled.</strong> Ticket holders are refunded automatically.</p>` : ""}
          </section>
        </div>
        <div class="wrap ev2-body">
          <section class="ev2-sec card"><h2>Details</h2><div class="ev2-main prose">${e.description || e.summary || ""}</div></section>
          ${lineup.length ? html`<section class="ev2-sec card"><h2>Lineup</h2><div class="ev2-main"><ul class="ev2-lineup">${lineup.map((a, i) => html`<li class="${i === 0 ? "headliner" : ""}"><span class="ev2-avatar" aria-hidden="true">${initials(a.name)}</span><span><a href="/?q=${encodeURIComponent(a.name)}">${a.name}</a>${a.time ? html`<span class="ev2-time">${a.time}</span>` : ""}</span></li>`)}</ul></div></section>` : ""}
          <section class="ev2-sec card"><h2>Information</h2><dl class="ev2-main ev2-info">${info.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}
            ${e.ref ? html`<div><dt>Event ID</dt><dd class="mono">${e.ref}</dd></div>` : ""}</dl></section>
          <section class="ev2-sec card"><h2>Organiser</h2><div class="ev2-main ev2-org"><div><p class="ev2-org-name">${e.organiser_name}${e.organiser_ref ? html` <span class="small muted mono nowrap">${e.organiser_ref}</span>` : ""}</p>
            ${e.organiser_about ? html`<p class="small muted">${e.organiser_about}</p>` : ""}
            <a class="ev-more" href="/?q=${encodeURIComponent(e.organiser_name)}">All events by this organiser</a></div>
            ${e.organiser_logo ? html`<span class="ev2-org-mark has-logo"><img src="/media/${e.organiser_logo}" alt="${e.organiser_name} logo"></span>` : html`<span class="ev2-org-mark" aria-hidden="true">${initials(e.organiser_name)}</span>`}</div></section>
          <section class="ev2-sec card"><h2>Venue</h2><div class="ev2-main"><div class="ev2-venue">${icon("pin")}<div><h3 class="mb-0">${e.venue_name}</h3><address>${e.address ? html`${e.address}<br>` : ""}${e.city}${e.province ? `, ${e.province}` : ""}</address></div></div>
            <div class="row mt"><a class="btn btn-ghost btn-sm" href="${mapUrl}" target="_blank" rel="noopener noreferrer">Google Maps</a>
              <a class="btn btn-ghost btn-sm" href="https://maps.apple.com/?daddr=${mapDestination}" target="_blank" rel="noopener noreferrer">Apple Maps</a>
              <a class="btn btn-ghost btn-sm" href="https://waze.com/ul?q=${mapDestination}&amp;navigate=yes" target="_blank" rel="noopener noreferrer">Waze</a>
              <button class="btn btn-ghost btn-sm" type="button" data-copy-address>Copy address</button></div></div></section>
        </div>
        ${e.status !== "cancelled" ? html`<div class="ev2-bar"><div class="wrap row between"><span>${fromCents !== null && !e.is_free ? html`From <strong>${money(fromCents)}</strong>` : html`<strong>${e.title}</strong>`}</span><a class="btn btn-primary" href="${ticketsUrl}">${buyLabel}</a></div></div>` : ""}
      </div>`);
    $("[data-copy-address]")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(place);
      } catch {
        const field = document.createElement("textarea");
        field.value = place; field.setAttribute("readonly", ""); field.style.position = "fixed"; field.style.opacity = "0";
        document.body.append(field); field.select();
        const copied = document.execCommand("copy"); field.remove();
        if (!copied) { toast("Copy is unavailable. Select the venue address and copy it manually.", "bad"); return; }
      }
      toast("Venue address copied.", "good");
    });
    $("[data-cashless]")?.addEventListener("click", () => {
      dialog(`Cashless at ${e.title}`, html`<div class="stack"><p>No cash or cards at the bars and food stalls. You pay with your wristband instead.</p>
        <ol class="stack small"><li>Buy your ticket, then link your wristband in your TicketRoom account (the code is printed on the band).</li><li>Top up by card before or during the event. Your balance is safe in your account.</li><li>Tap to pay at any stall. Purchases above a set amount need your PIN.</li><li>Lost your wristband? Block it in your account straight away and move your balance to a new one.</li><li>Money left over after the event can be refunded from your account.</li></ol>
        <div class="row end"><button class="btn btn-primary" data-close>Got it</button></div></div>`);
    });
    const cal = document.createElement("button");
    cal.type = "button"; cal.className = "pill-btn"; cal.textContent = "Add to calendar";
    cal.addEventListener("click", () => calendarFile({ title: e.title, starts: e.starts_at, ends: e.ends_at, place, url: eventUrl }));
    $("[data-actions]").append(likeButton(e.slug, { liked: e.liked, likes: e.likes }), cal, shareBar(eventUrl, e.title, { text: `${e.title}, ${fmtDate(e.starts_at, { day: "numeric", month: "long" })} at ${e.venue_name}` }));
    return;
  }
  // The ticket page: steps along the top (Select tickets, Your details, Pay, Done).
  const setStep = (n) => $$(".tix-steps li").forEach((li, i) => { li.classList.toggle("done", i < n); if (i === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current"); });
  setStep(0);
  const box = $("#box");
  const queueStorageKey = `tr_presale_${slug}`;
  let queueToken = e.presale_queue_enabled ? sessionStorage.getItem(queueStorageKey) || "" : "";
  let queueState = null;
  let queueInWindow = !!(e.presale_queue_enabled && e.sales_start_at && Date.now() >= Date.parse(e.sales_start_at) - 15 * 60 * 1000 && Date.now() < Date.parse(e.sales_start_at) + 60 * 60 * 1000);
  let queuePollTimer = null;
  const drawQueue = () => {
    if (queuePollTimer) clearTimeout(queuePollTimer);
    setStep(0);
    render(box, html`<div class="tix-single card"><h2 id="tix-h">Presale queue</h2><div data-queue-status></div><div data-queue-action></div></div>`);
    const status = $(`[data-queue-status]`, box), action = $(`[data-queue-action]`, box);
    if (!queueToken) {
      status.textContent = "Join the queue for a fair place in line. It opens 15 minutes before ticket sales.";
      render(action, html`<form class="stack" id="pq-join"><div class="field"><label for="pq-name">Your name</label><input id="pq-name" name="fullName" autocomplete="name" required maxlength="120"></div><div class="field"><label for="pq-email">Email</label><input id="pq-email" name="email" type="email" autocomplete="email" required><span class="hint">Use this same email at checkout.</span></div><button class="btn btn-primary btn-block">Join the queue</button></form>`);
      onSubmit($("#pq-join"), async (v) => { const r = await post(`/api/public/events/${encodeURIComponent(slug)}/presale-queue/join`, v); if (!r.queue.token) { toast("This email already has a queue place. Continue in the browser where you joined.", "good"); return; } queueToken = r.queue.token; queueState = r.queue; sessionStorage.setItem(queueStorageKey, queueToken); drawQueue(); });
      return;
    }
    const s = queueState || { status: "waiting", position: null };
    if (s.status === "admitted") {
      status.textContent = `You’re in. Choose tickets now. Your place is held until ${fmtTime(s.admittedUntil)}.`;
      render(action, html`<button class="btn btn-primary btn-block" data-enter>Choose tickets</button>`);
      $("[data-enter]", box).addEventListener("click", () => drawSelect());
    } else if (s.status === "used") status.textContent = "This queue pass has already been used. Check your email for your booking.";
    else if (s.status === "expired") {
      status.textContent = "Your place has expired. Rejoin the queue for a new place.";
      render(action, html`<button class="btn btn-ghost" data-rejoin>Rejoin queue</button>`);
      $("[data-rejoin]", box).addEventListener("click", () => { sessionStorage.removeItem(queueStorageKey); queueToken = ""; queueState = null; drawQueue(); });
    } else status.textContent = `You’re in the queue${s.position ? `, number ${s.position}` : ""}. Admission is in order of joining. We’ll keep this page updated; once admitted, you have 10 minutes to check out.`;
    if (e.resale?.length) {
      const resale = document.createElement("div");
      render(resale, html`<section class="resale-box mt"><h3>Resale tickets</h3><p class="small muted">These fan-to-fan tickets are available while the presale queue is running.</p>${e.resale.map((l) => html`<div class="tt resale-tt"><div class="info"><div class="name">${l.ticketType}</div><div class="meta">${moneyExact(l.priceCents)} + ${moneyExact(l.feeCents)} service fee</div></div><button type="button" class="btn btn-primary btn-sm" data-resale="${l.id}">Buy</button></div>`)}</section>`);
      action.append(resale);
      $$('[data-resale]', resale).forEach((b) => b.addEventListener('click', async () => drawResale(e.resale.find((l) => l.id === b.dataset.resale), await me())));
    }
    if (s.status === "waiting" || s.status === "admitted") queuePollTimer = setTimeout(async () => { try { queueState = (await get(`/api/public/presale-queue/${encodeURIComponent(queueToken)}`)).queue; } catch { sessionStorage.removeItem(queueStorageKey); queueToken = ""; queueState = null; } drawQueue(); }, document.hidden ? 15000 : 8000);
  };
  if (e.presale_queue_enabled && e.sales_start_at && !queueInWindow) {
    const openAt = Date.parse(e.sales_start_at) - 15 * 60 * 1000;
    const closeAt = Date.parse(e.sales_start_at) + 60 * 60 * 1000;
    const revealQueue = () => {
      const remaining = openAt - Date.now();
      if (Date.now() >= closeAt) return;
      if (remaining <= 0) { queueInWindow = true; drawQueue(); setTimeout(() => { queueInWindow = false; drawSelect(); }, closeAt - Date.now()); }
      else setTimeout(revealQueue, Math.min(remaining, 2147480000));
    };
    setTimeout(revealQueue, Math.min(openAt - Date.now(), 2147480000));
  } else if (queueInWindow) {
    setTimeout(() => { queueInWindow = false; drawSelect(); }, Math.max(0, Date.parse(e.sales_start_at) + 60 * 60 * 1000 - Date.now()));
  }
  const selection = () => ticketTypes.filter((t) => qty[t.id] > 0).map((t) => ({ ticketTypeId: t.id, quantity: qty[t.id] }));
  let openGroups = null;
  const drawSelect = () => {
    if (queueInWindow && (!queueState || queueState.status !== "admitted")) { drawQueue(); return; }
    const count = Object.values(qty).reduce((a, b) => a + b, 0);
    const sub = ticketTypes.reduce((s, t) => s + t.price_cents * qty[t.id], 0);
    const fee = ticketTypes.reduce((s, t) => s + t.fee_cents * qty[t.id], 0);
    setStep(0);
    // Ticket groups (e.g. General, VIP, Tables) as panels that open and close, each with its own banner.
    const cfgGroups = Array.isArray(e.ticket_groups) ? e.ticket_groups : [];
    const names = [];
    for (const g of cfgGroups) if (ticketTypes.some((t) => (t.group_name || "") === g.name)) names.push(g.name);
    for (const t of ticketTypes) { const n = t.group_name || ""; if (!names.includes(n)) names.push(n); }
    const grouped = names.length > 1 || (names.length === 1 && names[0] !== "");
    const groups = names.map((n) => ({ name: n || (grouped ? "Tickets" : ""), key: n, meta: cfgGroups.find((g) => g.name === n) || {}, types: ticketTypes.filter((t) => (t.group_name || "") === n) }));
    if (!openGroups) openGroups = new Set(groups.length <= 2 ? groups.map((g) => g.key) : [(groups.find((g) => g.types.some((t) => t.remaining > 0 && buyable(t))) || groups[0])?.key]);
    // A sold-out phase whose next phase is selling needs no waitlist: buyers move on to the next one.
    const succeeded = (t) => ticketTypes.some((x) => x.release_after === t.id && buyable(x) && x.remaining > 0);
    const phaseNote = (t) => t.release_state === "next" ? html`<span class="tt-next">Next release</span> · opens when ${t.release_after_name} sells out`
      : t.release_state === "scheduled" ? html`<span class="tt-next">Coming soon</span> · opens ${fmtDate(t.sales_start_at, { day: "numeric", month: "short" })} at ${fmtTime(t.sales_start_at)}`
      : t.release_state === "ended" ? html`<span class="tt-out">Sales ended</span>` : "";
    const row = (t) => html`<div class="tt ${buyable(t) ? "" : "tt-locked"}"><div class="info"><div class="name">${t.name}</div>
          <div class="meta">${t.price_cents === 0 ? "Free" : html`<strong class="tt-price">${moneyExact(t.price_cents)}</strong>${t.fee_cents ? html` <span>+ ${moneyExact(t.fee_cents)} service fee</span>` : ""}`}${!buyable(t) ? "" : t.remaining === 0 ? html` · <span class="tt-out">Sold out</span>` : t.remaining < 25 ? ` · Only ${t.remaining} left` : ""}</div>
          ${!buyable(t) ? html`<div class="meta">${phaseNote(t)}</div>` : ""}
          ${t.admits > 1 || TICKET_KINDS[t.kind]?.note ? html`<div class="meta">${[t.admits > 1 ? `Admits ${t.admits} people` : "", TICKET_KINDS[t.kind]?.note || ""].filter(Boolean).join(" · ")}</div>` : ""}
          ${t.description ? html`<div class="meta">${t.description}</div>` : ""}
          ${t.remaining === 0 && buyable(t) && !closed && !succeeded(t) ? (t.on_waitlist ? html`<p class="wl-on" role="status">You're on the waitlist. We'll email you when one comes up.</p>`
            : html`<button type="button" class="btn btn-ghost btn-sm wl-join" data-wl="${t.id}">Join the waitlist</button>`) : ""}</div>
        <div class="stepper" role="group" aria-label="${t.name} quantity"><button data-dec="${t.id}" aria-label="Fewer ${t.name}" ${raw(qty[t.id] === 0 ? "disabled" : "")}>−</button><output aria-live="polite">${qty[t.id]}</output><button data-inc="${t.id}" aria-label="More ${t.name}" ${raw(closed || !buyable(t) || qty[t.id] >= Math.min(t.per_order_limit, t.remaining) ? "disabled" : "")}>+</button></div></div>`;
    const groupStatus = (g) => { const open = g.types.filter((t) => t.remaining > 0 && buyable(t)); if (open.length) { const p = Math.min(...open.map((t) => t.price_cents)); return p === 0 ? "Free" : `From ${money(p)}`; } return g.types.some((t) => t.release_state === "next" || t.release_state === "scheduled") ? "Coming soon" : "Sold out"; };
    const picked = ticketTypes.filter((t) => qty[t.id] > 0);
    const disabled = count === 0 || closed || (!cfg.cardPaymentsEnabled && sub > 0);
    render(box, html`<div class="tix-grid"><div class="tix-list">
      <h2 id="tix-h" class="sr-only">Choose tickets</h2>
      ${closed ? html`<p class="callout warn">${e.preview ? "Preview only. Tickets go on sale once the event is published." : e.status === "cancelled" ? "Sales are closed." : "Ticket sales are not open right now."}</p>` : ""}
      ${!ticketTypes.length ? html`<section class="card"><p class="muted mb-0">No tickets available.</p></section>`
        : grouped ? groups.map((g) => html`<details class="tix-group card" data-group="${g.key}" ${raw(openGroups.has(g.key) ? "open" : "")}>
          <summary>${g.meta.imageUploadId ? html`<span class="tix-group-img"><img src="/media/${g.meta.imageUploadId}" alt="" loading="lazy"></span>` : ""}
            <span class="tix-group-head"><span><span class="tix-group-name">${g.name}</span>${g.meta.note ? html`<span class="tix-group-note">${g.meta.note}</span>` : ""}</span>
              <span class="tix-group-side"><span class="tix-group-status">${groupStatus(g)}</span>${icon("chevron")}</span></span></summary>
          <div class="tix-group-body">${g.types.map(row)}</div></details>`)
        : html`<section class="card tix-plain">${ticketTypes.map(row)}</section>`}
      ${e.resale?.length ? html`<section class="resale-box card" aria-labelledby="rs-h"><h3 id="rs-h">Resale tickets</h3>
        <p class="small muted">Sold out, but these fans can't make it. Every resale ticket costs no more than they paid, and you get a brand new ticket with its own code.</p>
        ${e.resale.map((l) => html`<div class="tt resale-tt"><div class="info"><div class="name">${l.ticketType}</div><div class="meta">${moneyExact(l.priceCents)} <span>+ ${moneyExact(l.feeCents)} service fee</span></div></div>
          <button type="button" class="btn btn-primary btn-sm" data-resale="${l.id}">Buy</button></div>`)}</section>` : ""}
      </div>
      <aside class="tix-cart card" aria-label="Your cart"><h2 class="tix-cart-h">${icon("cart")}Cart</h2>
        ${picked.length ? html`<div class="tix-lines">${picked.map((t) => html`<div class="line"><span>${qty[t.id]} × ${t.name}</span><span>${moneyExact(t.price_cents * qty[t.id])}</span></div>`)}</div>` : html`<p class="muted small">Your cart is empty.</p>`}
        <div class="totals"><div class="line"><span>${count} ticket${count === 1 ? "" : "s"}</span><span>${moneyExact(sub)}</span></div>
          <div class="line"><span>Booking fee</span><span>${moneyExact(fee)}</span></div>
          <div class="line total"><span>Total</span><span>${moneyExact(sub + fee)}</span></div></div>
        ${!cfg.cardPaymentsEnabled && sub > 0 ? html`<p class="callout warn mt">Paid tickets go on sale soon. Free tickets are available now.</p>` : ""}
        <button class="btn btn-primary btn-block mt" data-continue ${raw(disabled ? "disabled" : "")}>Continue</button>
        <p class="trust mt mb-0">${e.is_free ? "This event is free. Choose how many tickets you need and register." : html`${icon("lock")}${e.service_fee_payer === "organiser" ? "The organiser covers the service fee. Got a promo code or voucher? Add it on the next step." : "The service fee is shown beside each ticket before checkout. Got a promo code or voucher? Add it on the next step."}`}</p>
      </aside></div>
      ${count ? html`<div class="tix-bar"><div class="row between"><span><span class="small">${count} ticket${count === 1 ? "" : "s"}</span><strong>${moneyExact(sub + fee)}</strong></span><button class="btn btn-primary" data-continue ${raw(disabled ? "disabled" : "")}>Continue</button></div></div>` : ""}`);
    $$("[data-group]", box).forEach((d) => d.addEventListener("toggle", () => { if (d.open) openGroups.add(d.dataset.group); else openGroups.delete(d.dataset.group); }));
    $$("[data-inc]", box).forEach((b) => b.addEventListener("click", () => { qty[b.dataset.inc]++; drawSelect(); $(`[data-inc="${b.dataset.inc}"]`, box)?.focus(); }));
    $$("[data-dec]", box).forEach((b) => b.addEventListener("click", () => { qty[b.dataset.dec]--; drawSelect(); $(`[data-dec="${b.dataset.dec}"]`, box)?.focus(); }));
    // No account needed: signed-in people check out as themselves, anyone else as a guest.
    $$("[data-continue]", box).forEach((b) => b.addEventListener("click", async () => drawCheckout(await me())));
    $$("[data-wl]", box).forEach((b) => b.addEventListener("click", () => joinWaitlist(ticketTypes.find((t) => t.id === b.dataset.wl))));
    $$("[data-resale]", box).forEach((b) => b.addEventListener("click", async () => drawResale(e.resale.find((l) => l.id === b.dataset.resale), await me())));
  };

  // Waitlist: signed-in customers join in one tap; anyone else gives a name and email.
  const customer = (u) => u && (u.account_type || "customer") === "customer";
  const joinWaitlist = async (t) => {
    const u = await me();
    const done = (r) => { t.on_waitlist = true; drawSelect(); toast(r.waitlist.already ? "You're already on the waitlist." : `You're on the waitlist, number ${r.waitlist.position} in line. We'll email you when a ticket comes up.`, "good"); };
    if (customer(u)) { try { done(await post(`/api/public/events/${slug}/waitlist`, { ticketTypeId: t.id })); } catch (err) { toast(err.message, "bad"); } return; }
    const d = dialog(`Waitlist: ${t.name}`, html`<form class="stack"><p class="mb-0">When a ${t.name} ticket comes up, we email you a private link that holds it for you for half an hour. First in line, first offered.</p>
      <div class="field"><label for="wl-name">Your name</label><input id="wl-name" name="fullName" autocomplete="name" required maxlength="120"></div>
      <div class="field"><label for="wl-email">Email</label><input id="wl-email" name="email" type="email" autocomplete="email" required></div>
      <button class="btn btn-primary btn-block">Join the waitlist</button><p class="tiny muted mb-0">We only use your email for this waitlist. You can leave it any time from the link we send.</p></form>`);
    onSubmit($("form", d), async (v) => { const r = await post(`/api/public/events/${slug}/waitlist`, { ticketTypeId: t.id, ...v }); d.close(); done(r); });
  };

  // Pay for a resale ticket, or for a ticket held by a waitlist offer.
  const go = (res) => {
    const k = res.accessKey ? `?k=${encodeURIComponent(res.accessKey)}` : "";
    if (res.payment?.redirectUrl && res.order.status === "pending_payment") location.href = res.payment.redirectUrl;
    else location.href = `/orders/${res.order.reference}${k}`;
  };
  const drawResale = (l, u, offer = null) => {
    const key = sessionStorage.getItem(`tr_idem_rs_${l.id}`) || idem();
    sessionStorage.setItem(`tr_idem_rs_${l.id}`, key);
    const asGuest = !customer(u) && !offer;
    setStep(1);
    render(box, html`<div class="tix-single card"><h2 id="tix-h">${offer ? "Your ticket is held" : "Resale ticket"}</h2>
      ${offer ? html`<p class="callout good mb-0" role="status">We're holding this ticket for you until <strong>${fmtTime(offer.expiresAt)}</strong>. After that it goes to the next person in line.</p>` : ""}
      <div class="totals"><div class="line"><span>1 × ${l.ticketType}${offer?.kind === "resale" || !offer ? " (resale)" : ""}</span><span>${moneyExact(l.priceCents)}</span></div>
        <div class="line"><span>Service fee</span><span>${moneyExact(l.feeCents)}</span></div><div class="line total"><span>Total</span><span>${moneyExact(l.priceCents + l.feeCents)}</span></div></div>
      <form class="stack mt" id="rpay">
        ${customer(u) ? html`<p class="small mb-0">Your ticket goes to <strong>${u.email}</strong>.</p>` : offer ? html`<p class="small mb-0">Your ticket goes to <strong>${offer.email}</strong>, the email you joined the waitlist with.</p>`
        : html`<fieldset class="stack card flat"><legend class="label">Your details</legend>
          <div class="field"><label for="r-name">Full name</label><input id="r-name" name="gName" autocomplete="name" required maxlength="120"></div>
          <div class="field"><label for="r-email">Email</label><input id="r-email" name="gEmail" type="email" autocomplete="email" required><span class="hint">Your ticket is sent here.</span></div></fieldset>`}
        ${!offer || offer.kind === "resale" ? html`<p class="small muted mb-0">A new ticket with its own QR code is made for you when you pay. The seller's old code stops working.</p>` : ""}
        ${cfg.paymentsTest ? html`<p class="callout warn mb-0"><strong>Test mode.</strong> Payments are being tested, so no real money moves and tickets are marked TEST. They will not get you in.</p>` : ""}
        <button class="btn btn-primary btn-block" type="submit">Pay ${moneyExact(l.priceCents + l.feeCents)}</button>
        <button class="btn btn-link btn-block" type="button" data-back>Back to tickets</button></form></div>`);
    $("[data-back]", box).addEventListener("click", () => { history.replaceState(null, "", location.pathname); drawSelect(); });
    onSubmit($("#rpay"), async (v) => {
      const res = offer && offer.kind === "primary"
        ? await post("/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: offer.ticketType.id, quantity: 1 }], idempotencyKey: key, waitlistOffer: offer.token })
        : await post(`/api/public/resale/${l.id}/orders`, { idempotencyKey: key, ...(offer ? { offer: offer.token } : {}), ...(asGuest ? { guest: { fullName: v.gName, email: v.gEmail } } : {}) });
      sessionStorage.removeItem(`tr_idem_rs_${l.id}`);
      go(res);
    });
  };

  const drawCheckout = async (u, promo = "") => {
    let pm = { links: [], titopayAvailable: false };
    if (u) try { pm = await get("/api/me/payment-methods"); } catch { /* card only */ }
    const titopay = pm.links.find((l) => l.provider === "titopay");
    let quote;
    try { quote = (await post("/api/public/checkout/quote", { eventSlug: slug, items: selection(), promoCode: promo || undefined })).quote; }
    catch (err) { if (promo) { toast(err.message, "bad"); return drawCheckout(u, ""); } throw err; }
    const key = sessionStorage.getItem(`tr_idem_${slug}`) || idem();
    sessionStorage.setItem(`tr_idem_${slug}`, key);
    setStep(1);
    render(box, html`<div class="tix-single card"><h2 id="tix-h">Your details</h2>
      <div class="totals">${quote.lines.map((l) => html`<div class="line"><span>${l.quantity} × ${l.name}</span><span>${moneyExact(l.unitPriceCents * l.quantity)}</span></div>`)}</div>
      <div class="totals"><div class="line"><span>Subtotal</span><span>${moneyExact(quote.subtotalCents)}</span></div>
        ${quote.discountCents ? html`<div class="line"><span>Code ${quote.promoCode}</span><span>−${moneyExact(quote.discountCents)}</span></div>` : ""}
        <div class="line"><span>Service fee</span><span>${moneyExact(quote.feeCents)}</span></div>
        <div class="line total"><span>Total</span><span>${moneyExact(quote.totalCents)}</span></div></div>
      <form class="row mt" id="promo"><label class="sr-only" for="pc">Promo code or voucher</label><input id="pc" name="code" placeholder="Promo code or voucher" class="grow" value="${quote.promoCode || ""}" maxlength="40" autocomplete="off"><button class="btn btn-ghost btn-sm">Apply</button></form>
      <form class="stack mt" id="pay">
        ${u ? html`<p class="small mb-0">Tickets go to <strong>${u.email}</strong>.</p>
        <div class="field"><label for="ph">Mobile number <span class="muted">(optional)</span></label><input id="ph" name="buyerPhone" type="tel" value="${u.phone || ""}" placeholder="082 123 4567"></div>`
        : html`<fieldset class="stack card flat"><legend class="label">Your details</legend>
          <p class="small muted mb-0">No account needed. We email your tickets, and you can add them to an account later. <button type="button" class="btn-link" data-signin>Sign in instead</button></p>
          <div class="field"><label for="g-name">Full name</label><input id="g-name" name="gName" autocomplete="name" required maxlength="120"></div>
          <div class="field"><label for="g-email">Email</label><input id="g-email" name="gEmail" type="email" autocomplete="email" required></div>
          <div class="field"><label for="g-email2">Confirm email</label><input id="g-email2" name="gEmail2" type="email" autocomplete="email" required><span class="hint">Your tickets are sent here, so check it twice.</span></div>
          <div class="field"><label for="ph">Mobile number <span class="muted">(optional)</span></label><input id="ph" name="buyerPhone" type="tel" autocomplete="tel" placeholder="082 123 4567"></div></fieldset>`}
        ${quote.totalCents > 0 ? html`<fieldset class="stack card flat"><legend class="label">Pay with</legend>
          <label class="check"><input type="radio" name="paymentMethod" value="card" checked><span>Card, EFT or instant EFT</span></label>
          ${pm.titopayAvailable ? (titopay ? html`<label class="check"><input type="radio" name="paymentMethod" value="titopay_wallet"><span>TitoPay wallet <span class="muted small">${titopay.display_handle}</span></span></label>`
            : html`<p class="small mb-0">Have a TitoPay wallet? <a href="/account#/payment-methods">Link it</a> to pay in one tap.</p>`) : ""}</fieldset>` : ""}
        <fieldset class="stack card flat"><legend class="label">Hear from ${e.organiser_name}? <span class="muted">(optional)</span></legend>
          <label class="check"><input type="checkbox" name="mEmail"><span>Email me about their future events</span></label>
          <label class="check"><input type="checkbox" name="mSms"><span>SMS me about their future events</span></label>
          <span class="tiny muted">Unsubscribe any time. We never sell your details.</span></fieldset>
        ${cfg.paymentsTest && quote.totalCents > 0 ? html`<p class="callout warn mb-0"><strong>Test mode.</strong> Payments are being tested, so no real money moves and tickets are marked TEST. They will not get you in.</p>` : ""}
        <p class="callout warn mb-0" id="pay-wait" role="status" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">${quote.totalCents === 0 ? "Get free tickets" : `Pay ${moneyExact(quote.totalCents)}`}</button>
        <button class="btn btn-link btn-block" type="button" data-back>Change tickets</button>
        <p class="tiny muted mb-0">By paying you agree to the <a href="/legal/terms">Terms</a> and the event's refund policy. Your tickets are reserved for a few minutes while you pay. Payment is confirmed by the payment provider, not by your browser.</p>
      </form></div>`);
    window.scrollTo({ top: 0, behavior: "smooth" });
    $("#promo").addEventListener("submit", (ev) => { ev.preventDefault(); drawCheckout(u, $("#pc").value.trim()); });
    $("[data-signin]", box)?.addEventListener("click", () => authDialog("signin", { portal: "customer", onDone: async () => { header($("#header")); drawCheckout(await me(true), promo); } }));
    $("[data-back]", box).addEventListener("click", drawSelect);
    onSubmit($("#pay"), async (v) => {
      if (!u && String(v.gEmail || "").trim().toLowerCase() !== String(v.gEmail2 || "").trim().toLowerCase()) {
        throw Object.assign(new Error("The two email addresses don't match."), { details: { gEmail2: "Must match the email above." } });
      }
      const body = {
        eventSlug: slug, items: selection(), promoCode: quote.promoCode || undefined, ref: ref || sessionStorage.getItem(`tr_ref_${slug}`) || undefined,
        retailPartnerRef: new URLSearchParams(location.search).get("retailer") || sessionStorage.getItem(`tr_retail_${slug}`) || undefined,
        ...(queueToken ? { presaleQueueToken: queueToken } : {}),
        buyerPhone: v.buyerPhone, marketingOptIn: { email: !!v.mEmail, sms: !!v.mSms }, idempotencyKey: key, paymentMethod: v.paymentMethod || "card",
        ...(u ? {} : { guest: { fullName: v.gName, email: v.gEmail, ...(v.buyerPhone ? { phone: v.buyerPhone } : {}) } }),
      };
      // On a big on-sale the server can be briefly too busy to answer. Try
      // again with the same key: the server books it once, however many tries.
      const note = $("#pay-wait");
      let res;
      for (let attempt = 0; ; attempt++) {
        try { res = await post("/api/public/orders", body, { timeoutMs: 25000 }); break; }
        catch (err) {
          const busy = err.status === 0 || err.status === 502 || err.status === 504 || (err.status === 503 && (!err.code || err.code === "busy"));
          if (!busy || attempt >= 7) { note.hidden = true; throw err; }
          note.hidden = false;
          note.textContent = "Lots of people are booking right now. Hold on, we're still trying. Please don't close this page.";
          await new Promise((r) => setTimeout(r, Math.min(8000, 1500 * 2 ** attempt) * (0.7 + Math.random() * 0.6)));
        }
      }
      sessionStorage.removeItem(`tr_idem_${slug}`);
      if (queueToken) sessionStorage.removeItem(queueStorageKey);
      setStep(res.payment?.redirectUrl && res.order.status === "pending_payment" ? 2 : 3);
      const k = res.accessKey ? `?k=${encodeURIComponent(res.accessKey)}` : "";
      if (res.payment?.redirectUrl && res.order.status === "pending_payment") location.href = res.payment.redirectUrl;
      else location.href = `/orders/${res.order.reference}${k}`;
    });
  };
  // A link from a waitlist email: the offered ticket, held for this person.
  const qp = new URLSearchParams(location.search);
  if (qp.get("leave")) {
    try { await post("/api/public/waitlist/leave", { token: qp.get("leave") }); toast("You've left the waitlist.", "good"); } catch (err) { toast(err.message, "bad"); }
    history.replaceState(null, "", location.pathname);
  }
  if (qp.get("offer")) {
    try {
      const { offer } = await get(`/api/public/waitlist/offer?t=${encodeURIComponent(qp.get("offer"))}`);
      drawResale({ id: offer.listingId || offer.ticketType.id, ticketType: offer.ticketType.name, priceCents: offer.priceCents, feeCents: offer.feeCents }, await me(), { ...offer, token: qp.get("offer") });
      $("#box").scrollIntoView({ block: "start" });
      return;
    } catch (err) {
      drawSelect();
      box.insertAdjacentHTML("afterbegin", `<p class="callout warn" role="status"></p>`);
      $(".callout", box).textContent = err.message;
      return;
    }
  }
  if (queueInWindow && queueToken) {
    try { queueState = (await get(`/api/public/presale-queue/${encodeURIComponent(queueToken)}`)).queue; }
    catch { sessionStorage.removeItem(queueStorageKey); queueToken = ""; }
  }
  if (queueInWindow && (!queueState || queueState.status !== "admitted")) drawQueue(); else drawSelect();
}

// ---------------- order status ----------------
// The order page: the buyer's tickets, signed in or from the private link in
// their email (?k=…). Guests see their QR codes here and are offered an
// account with the same email, which collects every ticket once confirmed.
function orderTicket(t, o) {
  const when = `${fmtDate(o.event.startsAt, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, ${fmtTime(o.event.startsAt)}`;
  const live = t.status === "valid" && t.qrUrl;
  const test = Number(t.test) === 1;
  return html`<div class="tk-wrap"><article class="ticket ${t.status === "used" ? "used" : live ? "" : "void"} ${test ? "is-test" : ""}" aria-label="${test ? "Test ticket" : "Ticket"} ${t.code}">
    ${test ? html`<p class="tk-test" role="note">TEST TICKET · not valid for entry</p>` : ""}
    <header class="tk-head"><span class="tk-label">TicketRoom ticket</span><h3>${o.event.title}</h3><p class="tk-when">${when}</p><p class="tk-where">${o.event.venue}, ${o.event.city}</p></header>
    <div class="tk-body"><dl class="tk-rows"><div><dt>Ticket</dt><dd>${t.ticket_type}</dd></div><div><dt>Holder</dt><dd>${t.holder_name || o.buyerName}</dd></div>${t.admits > 1 ? html`<div><dt>Admits</dt><dd>${t.admits} people</dd></div>` : ""}<div><dt>Order</dt><dd class="mono">${o.reference}</dd></div></dl>
      <div class="t-qr">${live ? html`<img src="${t.qrUrl}" alt="QR code for ticket ${t.code}" width="220" height="220">` : html`<span class="stamp ${t.status === "used" ? "" : "muted"}">${t.status}</span>`}</div>
      <p class="tk-scan">${t.status === "used" ? `Scanned ${fmtDateTime(t.admitted_at)}` : live ? "Scan at the entrance" : ""}</p></div>
    <div class="tk-perf" aria-hidden="true"></div>
    <div class="tk-foot"><span class="tk-label">Ticket code</span><span class="tk-code">${t.code}</span><p class="tk-note">Present this ticket at the entrance. Do not share the code publicly.</p></div>
  </article>
  ${live ? html`<div class="tk-actions no-print"><div class="row"><button class="btn btn-ghost btn-sm" data-img="${t.id}">Save ticket image</button><button class="btn btn-ghost btn-sm" data-cal>Add to calendar</button><button class="btn btn-ghost btn-sm" data-print>Print</button></div></div>` : ""}</div>`;
}

async function orderPage(ref) {
  const k = new URLSearchParams(location.search).get("k") || "";
  const signedIn = !!(await me());
  if (!k && !signedIn) {
    const u = await requireUser("Sign in to view your order, or open the link in your confirmation email.");
    if (!u) return;
  }
  const q = k ? `?k=${encodeURIComponent(k)}` : "";
  let tries = 0;
  const draw = async () => {
    const { order: o, items, tickets, payment, guest, email, ticketsHidden, ticketCount } = await get(`/api/public/orders/${encodeURIComponent(ref)}${q}`);
    const wallet = payment?.method === "titopay_wallet";
    document.title = `Order ${o.reference} | TicketRoom`;
    const pending = o.status === "pending_payment";
    const paid = o.status === "paid" || o.status === "partially_refunded";
    render(main, html`<div class="wrap section stack-lg"><div class="card pad-lg stack" aria-live="polite">
      <div class="row between"><span class="muted small">Order ${o.reference}</span><span class="row">${o.test ? html`<span class="badge warn">Test</span>` : ""}${badge(o.status)}</span></div>
      ${o.test ? html`<p class="callout warn mb-0"><strong>Test order.</strong> This was paid while TicketRoom payments were in test mode. No real money moved, and these tickets will not open the gate.</p>` : ""}
      ${paid && ticketsHidden ? html`<h1>Booking confirmed</h1><p>${ticketCount} ticket${ticketCount === 1 ? " is" : "s are"} booked for <strong>${o.event.title}</strong> and sent to the email address on the order. To see them, open the link in that confirmation email, or sign in with that email address.</p>`
        : paid ? html`<h1>You're going</h1><p>Your ${tickets.length} ticket${tickets.length === 1 ? " is" : "s are"} ready for <strong>${o.event.title}</strong>. We've emailed them to you as well.</p>
          ${guest ? html`<div class="callout"><strong>Keep your tickets in one place.</strong> Create a free account with <strong>${email}</strong> and confirm it: these tickets, and any you buy later, will be waiting there. You can then pass a ticket to a friend or change the name on it.
            <div class="row mt"><button class="btn btn-primary btn-sm" data-make-account>Create my account</button></div></div>`
          : html`<div class="row"><a class="btn btn-primary" href="/account#/tickets">View my tickets</a><a class="btn btn-ghost" href="/events/${o.event.slug}">Back to event</a></div>`}
          <div class="card flat stack"><strong>Tell your friends you're going</strong><div data-share></div></div>`
        : pending && wallet && payment.status === "failed" ? html`<h1>Payment not approved</h1><p>The TitoPay wallet payment was declined or not approved in time. Nothing was charged.</p><div class="row"><button class="btn btn-primary" data-repay>Try again</button><button class="btn btn-ghost" data-cancel>Cancel order</button></div>`
        : pending && payment && ["failed", "cancelled"].includes(payment.status) ? html`<h1>Payment not completed</h1><p>The payment was cancelled or declined, so nothing was charged. Your tickets are still held for a few minutes.</p><div class="row"><button class="btn btn-primary" data-repay>Try paying again</button><button class="btn btn-ghost" data-cancel>Cancel order</button></div>`
        : pending ? html`<h1>Confirming your payment…</h1><p>We're waiting for the payment provider to confirm. This usually takes a few seconds. Please don't pay again.</p>${tries > 20 ? html`<p class="callout warn">Still waiting. If you completed payment, your tickets will appear as soon as the provider confirms, and we'll email them to you. <button class="btn-link" data-repay>Return to payment</button> · <button class="btn-link" data-cancel>Cancel order</button></p>` : spinner()}`
        : o.status === "paid_unfulfilled" ? html`<h1>Payment received, but the tickets ran out</h1><p class="callout warn">Your payment arrived after your reservation expired and the tickets had sold out. A full refund has been started automatically.</p>`
        : o.status === "refunded" ? html`<h1>Order refunded</h1><p>This order was refunded in full${o.refundedCents ? ` (${moneyExact(o.refundedCents)})` : ""}. Card refunds usually reach your account within 5 to 10 working days.</p>`
        : html`<h1>${o.status === "expired" ? "Reservation expired" : o.status === "cancelled" ? "Order cancelled" : "Order " + o.status.replace(/_/g, " ")}</h1><p>No tickets were issued${o.status === "expired" || o.status === "cancelled" ? " and nothing was charged" : ""}.</p><a class="btn btn-primary" href="/events/${o.event.slug}">Try again</a>`}
      <div class="card flat"><h3>${o.event.title}</h3><p class="muted small mb-0">${fmtDateTime(o.event.startsAt)} · ${o.event.venue}, ${o.event.city}</p>
        <div class="totals">${items.map((i) => html`<div class="line"><span>${i.quantity} × ${i.name}</span><span>${moneyExact(i.unit_price_cents * i.quantity)}</span></div>`)}
        ${o.discountCents ? html`<div class="line"><span>Discount</span><span>−${moneyExact(o.discountCents)}</span></div>` : ""}
        <div class="line"><span>Service fee</span><span>${moneyExact(o.feeCents)}</span></div><div class="line total"><span>Total</span><span>${moneyExact(o.totalCents)}</span></div>
        ${o.refundedCents ? html`<div class="line"><span>Refunded</span><span>−${moneyExact(o.refundedCents)}</span></div>` : ""}</div></div>
    </div>
    ${paid && (guest || k) && tickets.length ? html`<div class="stack-lg">${tickets.map((t) => orderTicket(t, o))}</div>` : ""}</div>`);
    $("[data-share]")?.append(shareBar(`${location.origin}/events/${o.event.slug}`, o.event.title, { text: `I'm going to ${o.event.title}. Get your ticket` }));
    $("[data-make-account]")?.addEventListener("click", () => authDialog("signup", { portal: "customer" }));
    $$("[data-print]").forEach((b) => b.addEventListener("click", () => window.print()));
    $$("[data-cal]").forEach((b) => b.addEventListener("click", () => calendarFile({ title: o.event.title, starts: o.event.startsAt, ends: o.event.endsAt, place: `${o.event.venue}, ${o.event.city}`, url: `${location.origin}/events/${o.event.slug}` })));
    $$("[data-img]").forEach((b) => b.addEventListener("click", async () => {
      const t = tickets.find((x) => x.id === b.dataset.img);
      try {
        const svg = await fetch(t.qrUrl, { credentials: "same-origin" }).then((r) => { if (!r.ok) throw new Error("Could not load the ticket."); return r.text(); });
        const png = await ticketPng(svg, { title: o.event.title, when: `${fmtDate(o.event.startsAt, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, ${fmtTime(o.event.startsAt)}`, place: `${o.event.venue}, ${o.event.city}`, code: t.code,
          rows: [["Ticket", t.ticket_type], ["Holder", t.holder_name || o.buyerName], ...(t.admits > 1 ? [["Admits", `${t.admits} people`]] : []), ["Order", o.reference]] });
        const a = document.createElement("a"); a.href = URL.createObjectURL(png); a.download = `ticket-${t.code}.png`; document.body.append(a); a.click(); a.remove();
        toast("Saved. Show this picture at the gate if you have no signal.", "good");
      } catch (err) { toast(err.message, "bad"); }
    }));
    $("[data-repay]")?.addEventListener("click", async () => { try { const r = await post(`/api/public/orders/${ref}/pay${q}`); if (r.payment.redirectUrl) location.href = r.payment.redirectUrl; else { tries = 0; draw(); } } catch (err) { toast(err.message, "bad"); } });
    $("[data-cancel]")?.addEventListener("click", async () => { await post(`/api/public/orders/${ref}/cancel${q}`); draw(); });
    if (pending && !(payment && ["failed", "cancelled"].includes(payment.status)) && tries++ < 120) setTimeout(draw, tries < 10 ? 1500 : 4000);
  };
  await draw();
}

// ---------------- organisers landing ----------------
async function sellPage() {
  document.title = "List your event | TicketRoom";
  const config = await appConfig();
  const fees = config.fees || { ticketFeeFixedCents: 1000, ticketFeeBps: 0, organiserCommissionBps: 500, organiserCommissionFixedCents: 250 };
  const feePerTicket = (price) => Number(price || 0) <= 0 ? 0 : Number(fees.ticketFeeFixedCents || 0) + Math.round(Number(price) * Number(fees.ticketFeeBps || 0) / 10000);
  const commissionPct = String(Number((Number(fees.organiserCommissionBps ?? 500) / 100).toFixed(2)));
  const cashlessCommissionPct = (Number(fees.cashlessVendorCommissionBps ?? 0) / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const tile = (icon, t, s) => html`<div class="card flat center"><div aria-hidden="true">${raw(icon)}</div><h3 class="mt">${t}</h3><p class="muted mb-0">${s}</p></div>`;
  const ic = (d) => `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#0B1D3F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  render(main, html`<section class="hero"><div class="wrap"><span class="cat-label">For organisers</span><h1>Your event, <b>sorted</b></h1>
      <p class="lead">List your event, sell or give away tickets, scan people in at the door and see who came. Built in South Africa, for South African events.</p>
      <div class="row"><button class="btn btn-primary" data-apply>Create an organiser account</button><a class="btn btn-outline-light" href="/organisers">Organiser login</a></div></div></section>
    <section class="section"><div class="wrap stack-lg">
      <div class="tiles">
        ${tile(ic('<path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6Z"/><path d="M12 9v1M12 14v1"/>'), "Tickets", "Free or paid tickets, early-bird releases, promo codes, and a limit on how many each person can book.")}
        ${tile(ic('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'), "Your event page", "Poster, line-up, venue and times on one page you can share on WhatsApp and socials. Preview it before it goes live.")}
        ${tile(ic('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M7 12h10"/>'), "At the door", "Your team scans tickets on their own phones, even offline. Each ticket gets in once, and you watch the count go up live.")}
        ${tile(ic('<rect x="2" y="8" width="20" height="8" rx="4"/><path d="M7 12h.01M17 12a5 5 0 0 0-1.5-3.5M19.5 12a7.5 7.5 0 0 0-2.2-5.3"/>'), "Cashless wristbands", "No cash, no card machines at the bar. Guests tap their wristband to pay and top up on their phones.")}
        ${tile(ic('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>'), "Vendor POS", "Bars and food stalls sell from any phone. Each vendor sees their own sales; you see them all.")}
        ${tile(ic('<path d="M3 20h18M6 16v-3M10 16V9M14 16v-5M18 16V6M4 11l5-5 4 3 7-6"/>'), "Get paid", "Live sales and analytics, then your money paid to your verified bank account after the event.")}
        <div class="card flat center" data-feature="promote"><div aria-hidden="true">${raw(ic('<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 0 0 13"/>'))}</div><h3 class="mt">Promote</h3><p class="muted mb-0">Email and SMS campaigns to the people who want to hear from you, plus a post on our socials. <span data-promote-price>R1 600</span> once off per event.</p></div>
      </div>
      <section class="card cashless-band" aria-labelledby="cl-h"><div class="grid-2">
        <div class="stack"><span class="cat-label">Cashless events</span><h2 id="cl-h" class="mb-0">Wristband payments at your event</h2>
          <p class="mb-0">Guests top up from their phones and pay at vendor stalls with a wristband. You can track sales by vendor in the organiser portal.</p>
          <ul class="tick-list"><li>Wristbands linked to each guest's ticket and account</li><li>Instant top-up by card before and during the event</li><li>A PIN for bigger purchases, so a found wristband is no use to anyone</li><li>Lost wristband? The guest blocks it in one tap and moves their balance to a new one</li><li>Unused money is refunded to guests after the event, automatically requested</li><li>Vendor sales, commission and settlement worked out for you</li></ul></div>
        <div class="stack"><h3 class="mb-0">How it works</h3>
          <ol class="cl-steps"><li><strong>You</strong> switch on cashless for the event and add your vendors and their menus.</li>
            <li><strong>Guests</strong> collect a wristband at the gate and link it to their ticket by the code printed on it.</li>
            <li><strong>They top up</strong> on their phone in seconds and see their balance and every purchase live.</li>
            <li><strong>Vendors</strong> sell by tapping or scanning the wristband on any phone, no card machine needed.</li>
            <li><strong>After the event</strong> vendors are settled and leftover balances go back to guests.</li></ol>
          <button class="btn btn-primary" data-apply>Plan a cashless event</button></div></div></section>
      <section class="promote-offer" aria-labelledby="pr-h" data-feature="promote"><div class="promote-pitch stack"><span class="tk-label">Promote</span><h2 id="pr-h" class="mb-0">Email and SMS for your event</h2>
          <p class="mb-0">Our email and SMS campaign tools bring the right people to your event in the right numbers. One payment promotes one event until it ends. No contracts, no per-email charges, no surprises.</p>
          <ul class="promote-ticks"><li><strong>Unlimited email campaigns</strong> to everyone who booked with you and opted in, until your event ends</li><li><strong>SMS campaigns</strong> to the same opted-in crowd</li><li><strong>A post on TicketRoom's socials:</strong> send us your caption and dates, we tell you when it is live</li><li><strong>Clear results:</strong> messages sent, clicks, tickets and revenue for every campaign</li><li><strong>Quick cash-out:</strong> pay by card or straight from your ticket balance</li></ul></div>
        <div class="promote-price"><div class="promote-amount" data-promote-price>R1 600</div><div class="small">once off, per event</div><p class="tiny mb-0">Buy it from your event's Promote tab in the organiser portal, once the event is published or waiting to be published.</p><button class="btn btn-primary btn-block" data-apply>Promote my event</button></div></section>
      <div class="card"><h2>What you get</h2><div class="grid-2">
        <ul><li>A live dashboard of bookings and sales, day by day</li><li>Tracking links, so you know whether Instagram or WhatsApp brought people in</li><li>Email campaigns to people who opted in, with unsubscribe built in (POPIA)</li><li>Ticket transfers that cancel the old QR code, so one ticket can never get two people in</li></ul>
        <ul><li>RFID/NFC wristbands and QR tags for cashless events</li><li>Vendor POS on any phone, with per-vendor reporting</li><li>Refunds with dual approval and a full audit trail</li><li>Payouts to your verified bank account once your event has run</li></ul></div>
      </div>
      <div class="card" id="pricing"><h2>What it costs</h2><div class="grid-3">
        <div><div class="kpi"><div class="k">Commission</div><div class="v">${commissionPct}% + ${moneyExact(fees.organiserCommissionFixedCents ?? 250)}</div><div class="s">per paid ticket, deducted from your payout</div></div></div>
        <div><div class="kpi"><div class="k">Service fee</div><div class="v">${moneyExact(fees.ticketFeeFixedCents || 0)}${fees.ticketFeeBps ? ` + ${(fees.ticketFeeBps / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%` : ""}</div><div class="s">per paid ticket; you choose who covers it</div></div></div>
        <div><div class="kpi"><div class="k">Free events</div><div class="v">R0</div><div class="s">no fees at all on free events</div></div></div></div>
        <p class="callout mt" data-feature="promote">Promote, optional: <span data-promote-price>R1 600</span> once off per event, everything included until the event ends.</p>
        <p class="callout mt">Cashless: no setup fee. Vendor commission is agreed per vendor; the current default is ${cashlessCommissionPct}%, shown on every settlement. Admin can set the default and each vendor's rate. Talk to us about wristbands for your event.</p>
        <p class="muted small mt mb-0">Set who covers the service fee for each event. Your final rate is shown before you publish; payouts are released after your event, less approved refunds.</p></div>
      <section class="card stack mt" aria-labelledby="fee-calc-title"><div><span class="cat-label">Plan your event</span><h2 id="fee-calc-title">Estimate your payout</h2><p class="muted mb-0">Adjust the numbers to see how commission and the service fee affect your estimate. Uses standard rates before discounts or refunds; organiser-specific commission may differ.</p></div>
        <div class="grid-2"><div class="field"><label for="calc-guests">Tickets sold</label><input id="calc-guests" type="number" min="1" max="200000" value="1000" inputmode="numeric"></div>
          <div class="field"><label for="calc-price">Average ticket price (R)</label><input id="calc-price" type="number" min="0" max="1000000" step="0.01" value="150" inputmode="decimal"></div>
          <div class="field"><label for="calc-order">Average tickets per order</label><input id="calc-order" type="number" min="1" max="50" value="2" inputmode="numeric"></div>
          <div class="field"><label for="calc-payer">Who covers the service fee?</label><select id="calc-payer"><option value="customer">Customer pays at checkout</option><option value="organiser">I cover it from my proceeds</option></select></div></div>
        <div class="kpis" aria-live="polite" data-calculator-results><div class="kpi"><div class="k">Gross ticket sales</div><div class="v" data-calc-turnover>–</div></div>
          <div class="kpi"><div class="k">Commission</div><div class="v" data-calc-commission>–</div><div class="s">${commissionPct}% + ${moneyExact(fees.organiserCommissionFixedCents ?? 250)} per paid ticket</div></div>
          <div class="kpi"><div class="k">Service fees covered by you</div><div class="v" data-calc-service>–</div></div>
          <div class="kpi"><div class="k">Estimated payout</div><div class="v" data-calc-payout>–</div><div class="s">Before refunds or other deductions</div></div></div>
        <p class="callout mb-0" data-calc-buyer>Customer service fee per average order: –</p></section>
    </div></section>`);
  // New here: account and organisation in one step. Signed in: straight to the organiser portal.
  $$("[data-apply]").forEach((b) => b.addEventListener("click", async () => { if (await me()) location.href = "/organisers"; else organiserSignupDialog(); }));
  // The estimate follows active settings; checkout remains the source of truth.
  const updateCalculator = () => {
    const tickets = Math.min(200000, Math.max(0, Number($("#calc-guests").value || 0)));
    const price = Math.max(0, Math.round(Number($("#calc-price").value || 0) * 100));
    const orderSize = Math.min(50, Math.max(1, Number($("#calc-order").value || 1)));
    const turnover = tickets * price;
    const commission = turnover > 0 ? Math.round(turnover * Number(fees.organiserCommissionBps ?? 500) / 10000) + tickets * Number(fees.organiserCommissionFixedCents ?? 250) : 0;
    const service = feePerTicket(price);
    const organiserPays = $("#calc-payer").value === "organiser";
    const organiserService = organiserPays ? tickets * service : 0;
    $("[data-calc-turnover]").textContent = moneyExact(turnover);
    $("[data-calc-commission]").textContent = moneyExact(commission);
    $("[data-calc-service]").textContent = moneyExact(organiserService);
    $("[data-calc-payout]").textContent = moneyExact(turnover - commission - organiserService);
    $("[data-calc-buyer]").textContent = organiserPays ? "You cover the service fee, so customers pay none at checkout." : `Customer service fee per average order: ${moneyExact(service * orderSize)}.`;
  };
  ["#calc-guests", "#calc-price", "#calc-order", "#calc-payer"].forEach((sel) => $(sel).addEventListener("input", updateCalculator));
  $("#calc-payer").addEventListener("change", updateCalculator);
  updateCalculator();
  appConfig().then((c) => { const p = c.promote?.priceCents; if (p) $$("[data-promote-price]").forEach((x) => { x.textContent = moneyExact(p).replace(/\.00$/, ""); }); });
}

// ---------------- about & partnerships ----------------
async function aboutPage() {
  document.title = "About TicketRoom | Your Event. Your Ticket.";
  render(main, html`
    <section class="hero"><div class="wrap"><span class="cat-label">About TicketRoom</span><h1>Your Event. <b>Your Ticket.</b></h1>
      <p class="lead">TicketRoom is a South African, Black-owned ticketing company. We help people find and book events, and give organisers tools to manage ticket sales and entry.</p></div></section>
    <section class="section"><div class="wrap stack-lg">
      <div class="grid-2"><article class="card pad-lg"><span class="cat-label">What we do</span><h2>Tickets and event tools</h2>
        <p>We provide ticketing for concerts, festivals, conferences, sport and private events. Guests can book online and keep their tickets on their phones.</p>
        <p class="mb-0">Organisers can list events, manage ticket sales, track orders and scan tickets at the gate.</p></article>
        <article class="card pad-lg"><span class="cat-label">For guests and organisers</span><h2>From booking to entry</h2>
          <p><strong>For guests:</strong> find an event, book online and access your ticket when you arrive.</p>
          <p class="mb-0"><strong>For organisers:</strong> set up ticket types, monitor sales and manage entry. We are developing cashless options for organisers, vendors and attendees.</p></article></div>
      <section class="card pad-lg"><span class="cat-label">South African owned and operated</span><h2>Built for local events</h2>
        <p>We work with event organisers across South Africa. Our focus is dependable ticketing, clear pricing and support when you need it.</p>
        <p class="mb-0">We want smaller events to have access to practical ticketing tools without the cost and complexity of a large event operation.</p></section>
      <div class="grid-2"><article class="card pad-lg"><span class="cat-label">Our focus</span><h2>Make event ticketing easier</h2><p class="mb-0">Help guests find and book events. Give organisers clear tools for ticket sales, attendee lists and entry.</p></article>
        <article class="card pad-lg"><span class="cat-label">Where we're going</span><h2>Grow across Africa</h2><p class="mb-0">Build a trusted ticketing service in South Africa, then expand to other African markets as we grow.</p></article></div>
      <section class="promo-band"><div><span class="cat-label">Explore TicketRoom</span><h2>Find an event or list yours</h2>
        <p class="mb-0">Browse upcoming events or set up a listing for your own.</p></div>
        <div class="row"><a class="btn btn-primary" href="/">Find an event</a><a class="btn btn-outline-light" href="/sell">List your event</a></div></section>
    </div></section>`);
}

async function partnersPage() {
  document.title = "Retail & Partners | TicketRoom";
  const retailEnabled = (await siteInfo())?.retail?.enabled === true;
  const partner = (title, body) => html`<article class="card"><h3>${title}</h3><p class="muted mb-0">${body}</p></article>`;
  render(main, html`
    <section class="hero"><div class="wrap"><span class="cat-label">Retail &amp; Partners</span><h1>Work with <b>TicketRoom</b></h1>
      <p class="lead">From putting on an event to selling tickets in your shop, find the right way to work with us.</p>
      <div class="row"><a class="btn btn-primary" href="/contact?as=organiser&amp;topic=partnership">Discuss a partnership</a>${retailEnabled ? html`<a class="btn btn-outline-light" href="/retail#apply">Become a retail partner</a>` : html`<a class="btn btn-outline-light" href="/retail">Retail partners coming soon</a>`}</div></div></section>
    <section class="section"><div class="wrap stack-lg">
      <div class="grid-2">
        <article class="card pad-lg stack"><span class="cat-label">Events, venues &amp; brands</span><h2>Bring your audience together</h2>
          <p class="muted">For event organisers, promoters, venues, artists, institutions and brands. List events, manage ticket sales and entry, or tell us about a wider collaboration.</p>
          <div><h3>Good fit for</h3><p class="muted mb-0">Concerts, festivals, conferences, private events, venue programmes and commercial or technology partnerships.</p></div>
          <a class="btn btn-primary" href="/contact?as=organiser&amp;topic=partnership">Send a partnership enquiry</a></article>
        <article class="card pad-lg stack"><span class="cat-label">Retail ticket partners</span><h2>Sell tickets from your shop</h2>
          ${retailEnabled ? html`<p class="muted">Apply to sell TicketRoom tickets in person. Approved partners get a retailer portal to record sales and choose supported payment and printing options.</p>
          <div class="row"><a class="btn btn-primary" href="/retail#apply">Apply to become a retailer</a><a class="btn btn-ghost" href="/retail#nearby">Find a nearby retailer</a></div>
          <p class="small muted mb-0">Customers can also browse approved shop locations and get directions from the retailer page.</p>` : html`<p class="muted">Retail ticket sales and new applications are coming soon. We’re preparing the partner portal and will open applications here when it’s ready.</p><a class="btn btn-ghost" href="/retail">Retail partner update</a>`}</article>
      </div>
      <section class="promo-band"><div><span class="cat-label">Not sure where to start?</span><h2>Tell us what you have in mind</h2>
        <p class="mb-0">Choose a partnership enquiry and include a little about your organisation, audience and timing. We’ll email you a reference to follow up.</p></div>
        <a class="btn btn-primary" href="/contact?as=organiser&amp;topic=partnership">Contact our partnerships team</a></section>
    </div></section>`);
}

async function careersPage() {
  document.title = "Careers | TicketRoom";
  let jobs = null;
  try { ({ jobs } = await get("/api/public/jobs")); } catch { /* show a useful retry state if the jobs service is unavailable */ }
  render(main, html`
    <section class="hero"><div class="wrap"><span class="cat-label">Careers</span><h1>Come work with <b>TicketRoom</b></h1>
      <p class="lead">We’re building better ways for people to find events and for organisers to bring them to life. See our current openings below.</p></div></section>
    <section class="section"><div class="wrap stack-lg">
      ${jobs === null ? html`<div class="card pad-lg stack"><span class="cat-label">Vacancies</span><h2>We can’t load the current openings</h2><p class="muted mb-0">Please try again in a moment.</p><button class="btn btn-ghost" type="button" data-retry-jobs>Try again</button></div>` : jobs.length ? html`<div class="stack-lg">${jobs.map((job) => html`<article class="card pad-lg stack job-opening">
        <div><span class="cat-label">${job.department}</span><h2>${job.title}</h2><p class="muted mb-0">${job.location} · ${job.employment_type}</p></div>
        <p class="lead mb-0">${job.summary}</p><div class="job-description">${job.description}</div>
        <div class="row between job-actions"><span class="small muted">${job.closes_at ? `Applications close ${fmtDate(`${job.closes_at}T12:00:00+02:00`, { day: "numeric", month: "long", year: "numeric" })}` : "Applications are open"}</span>
          <a class="btn btn-primary" href="${job.application_url}" target="_blank" rel="noopener noreferrer">Apply for this role <span aria-hidden="true">→</span></a></div>
      </article>`)}</div>` : html`<div class="card pad-lg stack"><span class="cat-label">No open roles</span><h2>Nothing available right now</h2><p class="muted mb-0">There are no current vacancies. Check back here for future opportunities.</p></div>`}
      <p class="small muted mb-0">For questions about a role, <a href="/contact">contact us</a>.</p>
    </div></section>`);
  $("[data-retry-jobs]")?.addEventListener("click", careersPage);
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
  const site = (await siteInfo()) || { legal: {}, support: {} };
  const docs = documents(site.legal || {}, site.support || {});
  const d = docs[doc];
  if (!d) return render(main, html`<div class="wrap section"><div class="card pad-lg"><h1>Page not found</h1><p>Choose a document:</p><ul>${ORDER.map(([k, t]) => html`<li><a href="/legal/${k}">${t}</a></li>`)}</ul></div></div>`);
  document.title = `${d.title} | TicketRoom`;
  const slug = (i) => `s${i + 1}`;
  render(main, html`<div class="wrap section"><div class="legal-layout">
    <nav class="legal-nav card" aria-label="Legal documents"><h2 class="h4">Legal</h2><ul>${ORDER.map(([k, t]) => html`<li><a href="/legal/${k}" ${raw(k === doc ? 'aria-current="page"' : "")}>${t}</a></li>`)}</ul>
      <p class="tiny muted mt mb-0">Questions? <a href="/contact">Use our contact form</a></p></nav>
    <article class="card pad-lg legal-doc stack">
      <header><h1>${d.title}</h1><p class="legal-meta mb-0">Version ${VERSION} · Effective ${EFFECTIVE}</p></header>
      <p class="lead">${d.summary}</p>
      ${d.important.length ? html`<aside class="legal-important" aria-labelledby="imp-h"><h2 id="imp-h">Please read these clauses carefully</h2><ul>${d.important.map((x) => html`<li>${markup(x)}</li>`)}</ul></aside>` : ""}
      ${d.sections.length > 3 ? html`<nav class="legal-toc" aria-label="Contents"><h2>Contents</h2><ol>${d.sections.map(([h], i) => html`<li><a href="#${slug(i)}">${h.replace(/^\d+\.\s*/, "")}</a></li>`)}</ol></nav>` : ""}
      ${d.sections.map(([h, body], i) => html`<section><h2 id="${slug(i)}">${h}</h2>${markup(body)}</section>`)}
      <footer class="legal-meta"><p class="mb-0">${site.legal?.entityName || "TicketRoom"} · ticketroom.co.za · <a href="/contact">Contact form</a></p></footer>
    </article></div></div>`);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

// ---------------- help and contact ----------------
const FAQ = [
  ["Where are my tickets?", "Sign in and open My tickets. Each ticket has its own QR code. Add the page to your home screen so it opens even with poor signal."],
  ["Can I send a ticket to a friend?", "Yes, if the organiser allows transfers. Open the ticket, choose Transfer and enter their email. Once they accept, your copy stops working."],
  ["I paid but have no tickets", "Payment is confirmed by the payment provider, which can take a minute. If nothing shows after 15 minutes, request a callback with your order reference. Please don't pay twice."],
  ["Can I list my event on TicketRoom?", "Yes. Create an organiser account, verify who you are, add your event and press Publish. We check every new event, usually within one working day, and it goes live straight away. Free and paid tickets, and cashless wristbands, are all available."],
  ["What does it cost?", "Free events cost nothing. For paid tickets, the current service fee and organiser commission are shown before checkout and in the organiser portal. Organisers choose whether to cover the service fee or have customers pay it."],
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
      <p class="mb-0">Send us a message using the contact form. We'll email you a case reference so you can follow up.</p>
      <p class="mb-0"><a class="row" style="gap:6px;display:inline-flex" href="${INSTAGRAM}" target="_blank" rel="noopener">${svgIcon("instagram", 18)} Follow us on Instagram: @ticketroom_za</a></p>
      <p class="mb-0"><a class="row" style="gap:6px;display:inline-flex" href="${X_SOCIAL}" target="_blank" rel="noopener">${svgIcon("x", 18)} Follow us on X: @ticketroom_za</a></p>
      <p class="mb-0"><a class="row" style="gap:6px;display:inline-flex" href="${FACEBOOK_SOCIAL}" target="_blank" rel="noopener">${svgIcon("facebook", 18)} Follow us on Facebook: @ticketroom.za</a></p>
      <h3>Office hours</h3>${site ? weekTable(site.hours) : html`<p>Monday to Friday, 9am to 5pm. Closed on weekends and public holidays.</p>`}
      ${site?.hours.upcomingHolidays?.length ? html`<p class="small muted mb-0">Upcoming closures: ${site.hours.upcomingHolidays.map((h) => `${fmtDate(h.date + "T12:00:00+02:00", { day: "numeric", month: "short" })} (${h.name})`).join(", ")}</p>` : ""}
      <p class="small muted mb-0">Requests received after hours, on weekends or public holidays are handled on the next working day.</p>
      ${site?.chatbot?.enabled && !site?.maintenance ? html`<button class="btn btn-ghost" data-open-chat>Ask the assistant now</button>` : ""}</section></div>`;
}

function wireSupport(root) {
  const f = $("#cbf", root);
  if (f) onSubmit(f, async (v) => {
    const r = await post("/api/site/callback", { ...v, source: "web" });
    render(f, html`<div class="callout good"><strong>Thanks, we've got it.</strong> Your reference is <strong>${r.reference}</strong>. We'll contact you within ${r.responseTime}. A confirmation is on its way to your email.</div>`);
  });
  $("[data-open-chat]", root)?.addEventListener("click", () => window.dispatchEvent(new CustomEvent("tr:chat")));
}

async function help() {
  document.title = "Help | TicketRoom";
  const [site, feat] = await Promise.all([siteInfo(), features()]);
  render(main, html`<div class="wrap section stack-lg"><div><h1>Help centre</h1><p class="lead mb-0">Find a quick answer below, ask our assistant, or ask us to call you back.</p></div>
    <div class="card faq-list">${FAQ.filter(([q]) => feat.cashless || !/cashless/i.test(q)).map(([q, a]) => html`<details class="faq"><summary>${q}</summary><p>${a}</p></details>`)}</div>
    <div id="sup">${await supportPanel(site)}</div></div>`);
  wireSupport(main);
}

// ---------------- event safety ----------------
async function safetyPage() {
  document.title = "Event Safety | TicketRoom";
  render(main, html`
    <section class="hero"><div class="wrap"><span class="cat-label">Event Safety</span><h1>Have a good night. <b>Get home safe.</b></h1>
      <p class="lead">A little planning makes it easier to enjoy the event and look out for the people around you.</p>
      <div class="row"><a class="btn btn-primary" href="#emergency">Emergency contacts</a><a class="btn btn-outline-light" href="#safety-tips">See the tips</a></div></div></section>
    <section class="section"><div class="wrap stack-lg">
      <section class="card pad-lg stack" id="emergency" aria-labelledby="safety-emergency-heading"><div><span class="cat-label">Save these numbers</span><h2 id="safety-emergency-heading">Need urgent help?</h2>
        <p class="muted mb-0">If someone is in immediate danger, alert venue security or the medical team and call for help. Tap a number below to call from your phone.</p></div>
        <div class="grid-3">
          <a class="card flat stack emergency-contact" href="tel:112"><span class="cat-label">Cellphone emergency</span><strong>112</strong><span class="small muted">Emergency response from a cellphone.</span><span class="btn btn-dark btn-sm">Call 112</span></a>
          <a class="card flat stack emergency-contact" href="tel:10111"><span class="cat-label">Police</span><strong>10111</strong><span class="small muted">SAPS police emergencies.</span><span class="btn btn-ghost btn-sm">Call 10111</span></a>
          <a class="card flat stack emergency-contact" href="tel:10177"><span class="cat-label">Ambulance</span><strong>10177</strong><span class="small muted">Ambulance emergency services.</span><span class="btn btn-ghost btn-sm">Call 10177</span></a>
        </div>
        <section class="card flat stack"><div><span class="cat-label">Private ambulance providers</span><h3>Need private medical help?</h3><p class="small muted mb-0">These national providers take emergency calls. They are independent services and may charge; availability and response depend on your location. Check costs with the call-taker if you can do so without delaying urgent help.</p></div>
          <div class="row"><a class="btn btn-ghost btn-sm" href="tel:084124">ER24 · 084 124</a><a class="btn btn-ghost btn-sm" href="tel:082911">Netcare 911 · 082 911</a></div>
          <p class="tiny muted mb-0">When calling, give the event name, exact gate or entrance, nearest road or landmark, what happened and how many people need help. Stay on the line and follow the call-taker’s instructions. <a href="https://www.er24.co.za/en/corporate/emergency.html" target="_blank" rel="noopener noreferrer">ER24 emergency information</a> · <a href="https://www.netcare.co.za/News-Hub/Articles/what-to-do-when-faced-with-a-medical-emergency" target="_blank" rel="noopener noreferrer">Netcare 911 emergency advice</a>.</p></section>
        <p class="tiny muted mb-0">Emergency services can vary by area. Follow the venue’s directions and tell staff where you are. For police assistance, use 10111 only for emergencies.</p>
      </section>
      <div id="safety-tips" class="grid-2">
        <article class="card pad-lg stack"><span class="cat-label">Before you go</span><h2>Make a simple plan</h2>
          <ul class="safety-list"><li>Check the venue, entry rules and your route home before you leave.</li><li>Charge your phone, keep your ticket and ID accessible, and never post your ticket QR code.</li><li>Tell someone you trust where you’re going and when you expect to be back. If you’re under 18, arrange your trip with a parent, guardian or trusted adult.</li><li>Agree on a meeting point with your friends in case you get separated.</li><li>Take only what you need. Keep your bag zipped and secure; don’t leave valuables unattended or visible in a car.</li></ul></article>
        <article class="card pad-lg stack"><span class="cat-label">At the event</span><h2>Stay aware, look out for each other</h2>
          <ul class="safety-list"><li>Notice the exits and where to find security or first aid when you arrive.</li><li>Keep your drink with you. Don’t take drinks from strangers or leave a drink unattended. If you lose sight of it or suspect it has been tampered with, don’t drink it; tell a friend and venue staff.</li><li>Keep your belongings close, bags zipped and phone out of easy reach. Don’t leave items on the floor, at a table or with someone you don’t know.</li><li>Be careful about sharing your room, travel or personal details with people you’ve just met. Stay with your group; if someone makes you uncomfortable or follows you, go to a well-lit staffed area and tell security.</li><li>Respect people’s space and consent. If something feels wrong, move to a staffed area and tell security.</li><li>If a friend becomes unwell or very intoxicated, stay with them and get venue medical staff or security immediately.</li><li>Follow instructions from event staff, especially if a crowd is moving or an area is being cleared. Don’t push; move calmly towards an open area if you feel unsafe.</li></ul></article>
        <article class="card pad-lg stack"><span class="cat-label">Getting home</span><h2>Leave together, arrive safely</h2>
          <ul class="safety-list"><li>Use your agreed route and pickup point. Wait in a well-lit public place and check the vehicle and driver details before getting in.</li><li>Use a trusted transport option. Don’t accept a lift from someone you don’t know or walk alone through an isolated area.</li><li>Stay with your group or let someone you trust know when you’re leaving; share your trip if your transport app offers it.</li><li>Never drive after drinking or get into a car with an impaired driver. Arrange a sober driver or another safe ride.</li></ul></article>
        <article class="card pad-lg stack safety-alcohol"><span class="cat-label">Alcohol &amp; age</span><h2>Alcohol is for 18+ only</h2>
          <p class="mb-0">At events, don’t buy, share or supply alcohol to anyone under 18. Venues may ask for valid ID. If someone is unwell after drinking, get medical help straight away; don’t leave them alone.</p>
          <p class="tiny muted mb-0">South African law prohibits selling or supplying liquor to minors, subject to a limited guardian-supervision exception. <a href="https://www.gov.za/documents/liquor-act" target="_blank" rel="noopener noreferrer">Read the Liquor Act</a>.</p></article>
      </div>
      <section class="card pad-lg stack" aria-labelledby="street-smart-heading"><div><span class="cat-label">Out and about</span><h2 id="street-smart-heading">Street-smart in South Africa</h2>
        <p class="muted mb-0">A few habits can help you stay aware on the way to and from an event. Crime is never the victim’s fault.</p></div>
        <div class="grid-2">
          <div class="card flat stack"><h3>On foot</h3><p class="small mb-0">Plan your route before you set off. Use busy, well-lit streets, walk with someone where possible and skip isolated shortcuts. Keep your phone, jewellery and cash out of sight. If you think you’re being followed, go into a staffed shop, venue or other busy place; don’t go home or confront the person.</p></div>
          <div class="card flat stack"><h3>At an ATM</h3><p class="small mb-0">Prefer an ATM inside a bank or shopping centre. Shield your PIN, keep your card in view and decline help from strangers. If anyone crowds or distracts you, cancel the transaction and leave; don’t let anyone take your card or see your PIN.</p></div>
          <div class="card flat stack"><h3>In a car</h3><p class="small mb-0">Lock the doors and keep windows mostly closed in traffic. Put bags and devices out of sight before you arrive, not while parked. Choose a well-lit, staffed parking area and keep your keys ready when returning to the car.</p></div>
          <div class="card flat stack"><h3>Meeting your ride</h3><p class="small mb-0">Use a trusted transport service, confirm the number plate and driver before getting in, and wait in a well-lit public pickup area. Share your trip with someone you trust when possible. Don’t accept an unsolicited lift or share a ride PIN with anyone except your verified driver.</p></div>
        </div>
        <p class="tiny muted mb-0">These are practical precautions, not guarantees. For more guidance, see <a href="https://www.saps.gov.za/alert/personal_safety_tips.php" target="_blank" rel="noopener noreferrer">SAPS personal safety tips</a> and <a href="https://www.saps.gov.za/alert/safety_tips_tourist.php" target="_blank" rel="noopener noreferrer">SAPS advice for visitors</a>.</p>
      </section>
      <section class="promo-band"><div><span class="cat-label">If you need help</span><h2>Speak up early</h2><p class="mb-0">Find event security, the organiser or first aid. You can also <a href="/contact">contact TicketRoom</a> about a ticket or account issue. For immediate danger, call emergency services.</p></div>
        <a class="btn btn-primary" href="#emergency">Emergency contacts</a></section>
      <p class="tiny muted mb-0">Official information: <a href="https://www.saps.gov.za/services/cc_10111.php" target="_blank" rel="noopener noreferrer">SAPS emergency calls</a> · <a href="https://www.westerncape.gov.za/know-who-you-can-call-emergency" target="_blank" rel="noopener noreferrer">Western Cape Government emergency numbers</a>.</p>
    </div></section>`);
}

// ---------------- subscribe to updates ----------------
async function subscribePage() {
  document.title = "Subscribe to updates | TicketRoom";
  const token = new URLSearchParams(location.search).get("t");
  if (!token) {
    render(main, html`<div class="wrap section"><div class="card pad-lg stack" style="max-width:640px"><h1>Subscribe to receive updates</h1>
      <p class="lead mb-0">Be first to hear about new events, ticket releases and free shows near you.</p><div data-sub></div></div></div>`);
    $("[data-sub]", main).append(subscribeForm("page"));
    return;
  }
  // From the confirmation email: confirm straight away (a script runs this, so
  // email scanners that only fetch the link do not subscribe anyone).
  render(main, html`<div class="wrap section"><div class="card pad-lg stack" style="max-width:640px" aria-live="polite">${spinner()}</div></div>`);
  const card = $(".card", main);
  try {
    const r = await post("/api/site/subscribe/confirm", { token });
    history.replaceState(null, "", "/subscribe");
    render(card, html`<h1>You're subscribed</h1><p class="mb-0">Updates will go to <strong>${r.email}</strong>. Every email has an unsubscribe link at the bottom.</p><a class="btn btn-primary" href="/">See what's on</a>`);
  } catch (err) {
    render(card, html`<h1>That link didn't work</h1><p class="mb-0">${err.message}</p><div data-sub></div>`);
    $("[data-sub]", card).append(subscribeForm("page"));
  }
}

// ---------------- advertising ----------------
async function advertisePage() {
  document.title = "Advertise your business | TicketRoom";
  const [u, site, config] = await Promise.all([me(), siteInfo(), appConfig()]);
  const adDaily = Number(config.fees?.advertisingDailyPriceCents ?? 5000);
  const adDailyText = moneyExact(adDaily).replace(/\.00$/, "");
  const tile = (t, s) => html`<div class="card flat"><h3>${t}</h3><p class="muted mb-0">${s}</p></div>`;
  render(main, html`<section class="hero"><div class="wrap"><span class="cat-label">Advertising</span><h1>Advertise your business on <b>TicketRoom</b></h1>
      <p class="lead">Get a spot from ${adDailyText} per day. Choose where your poster appears; we confirm the dates and final quote before it goes live.</p>
      <div class="row"><a class="btn btn-primary" href="#get-a-spot">Get a spot</a><a class="btn btn-outline-light" href="/contact?as=organiser">Contact us</a></div></div></section>
    <section class="section"><div class="wrap stack-lg">
      <div><span class="cat-label">Available placements</span><h2>Choose where you show up</h2><p class="muted">Your 16:9 poster links straight to your website, WhatsApp or booking page. We’ll confirm availability for your dates before taking payment.</p>
        <div class="grid-2">${tile("Home page Featured rail", "A sponsored poster in the Featured section, after event discovery and trending. Best for reaching people exploring TicketRoom.")}${tile("Event discovery rail", "A sponsored poster directly below Upcoming events, in the main event-browsing flow.")}</div></div>
      <div class="grid-3">
        ${tile("Seen by people going out", "Our visitors are planning their weekend: concerts, comedy, sport and festivals. Restaurants, transport, fashion and anything else for a night out fit right in.")}
        ${tile("Your dates, your budget", "Run your poster for a day, a weekend or a whole month. You pay only for the days you choose.")}
        ${tile("One tap to you", "Tapping your poster takes people straight to your website, WhatsApp or booking page.")}
      </div>
      <div class="grid-2">
        <div class="card"><div class="kpi"><div class="k">Featured poster</div><div class="v">From ${adDailyText}</div><div class="s">per day</div></div>
          <p class="small muted mt mb-0">We confirm the price, dates and poster with you before anything goes live. Nothing is charged online.</p></div>
        <div class="card"><h2>How it works</h2><ol class="mb-0">
          <li>Send us your details below.</li>
          <li>We reply within ${site?.support?.responseTime || "24–48 hours"} (Monday to Friday) with a quote and available dates.</li>
          <li>Send us your poster image and the link it should open. It goes live on your first day.</li></ol></div>
      </div>
      <section class="card stack" id="get-a-spot"><div><span class="cat-label">Tell us about your campaign</span><h2 class="mb-0">Get a spot</h2><p class="small muted mb-0 mt-sm">We’ll email you a reference and follow up with available dates and a quote.</p></div>
        <form class="stack" id="ad-enquiry" novalidate>
          <div class="grid-2"><div class="field"><label for="ad-name">Your name</label><input id="ad-name" name="fullName" autocomplete="name" required minlength="2" maxlength="120" value="${u?.full_name || ""}"></div>
            <div class="field"><label for="ad-email">Email</label><input id="ad-email" name="email" type="email" autocomplete="email" required value="${u?.email || ""}"></div></div>
          <div class="grid-2"><div class="field"><label for="ad-phone">Phone number <span class="muted">(optional)</span></label><input id="ad-phone" name="phone" type="tel" autocomplete="tel" maxlength="30" value="${u?.phone || ""}"></div>
            <div class="field"><label for="ad-business">Business or organisation</label><input id="ad-business" name="companyName" required minlength="2" maxlength="160" autocomplete="organization" placeholder="Business name"></div></div>
          <div class="grid-2"><div class="field"><label for="ad-campaign">What would you like to advertise?</label><input id="ad-campaign" name="campaign" required maxlength="240" placeholder="Product, service, event or campaign"></div>
            <div class="field"><label for="ad-dates">Dates you have in mind <span class="muted">(optional)</span></label><input id="ad-dates" name="campaignDates" maxlength="120" placeholder="e.g. 12–14 June"></div></div>
          <div class="field"><label for="ad-link">Where should your poster link? <span class="muted">(optional)</span></label><input id="ad-link" name="website" type="url" maxlength="300" placeholder="https://yourwebsite.co.za"><span class="hint">A website, booking page or WhatsApp link is fine.</span></div>
          <div class="field"><label for="ad-notes">Anything else we should know? <span class="muted">(optional)</span></label><textarea id="ad-notes" name="message" maxlength="2000" rows="4" placeholder="Tell us about your audience, preferred placement or budget."></textarea></div>
          <button class="btn btn-primary">Send my enquiry</button>
          <p class="tiny muted mb-0">We use these details only to respond to you. See our <a href="/legal/privacy">Privacy Policy</a>.</p></form></section>
    </div></section>`);
  const form = $("#ad-enquiry");
  onSubmit(form, async (v) => {
    const message = [
      `What they'd like to advertise: ${v.campaign}`,
      v.campaignDates ? `Dates in mind: ${v.campaignDates}` : "",
      v.message ? `Additional details: ${v.message}` : "",
    ].filter(Boolean).join("\n");
    const r = await post("/api/site/contact", { audience: "organiser", queryType: "advertising", fullName: v.fullName, email: v.email,
      phone: v.phone || undefined, companyName: v.companyName, website: v.website || undefined, message });
    render(form, html`<div class="callout good"><strong>Enquiry received.</strong><p class="mb-0 mt-sm">Your reference is <strong>${r.reference}</strong>. We’ve sent a copy to your email and will reply within ${r.responseTime}.</p><a class="btn btn-ghost mt" href="/">Back to events</a></div>`);
  });
}

const CONTACT_TYPES = {
  customer: [["tickets", "My tickets"], ["order", "Payment or order problem"], ["refund", "Refund"], ["transfer", "Transfer a ticket"], ["cashless", "Cashless or wristband"], ["account", "My account"], ["event", "Question about an event"], ["other", "Something else"]],
  organiser: [["partnership", "Partnership enquiry"], ["advertising", "Advertising enquiry"], ["selling", "Selling tickets"], ["setup", "Setting up an event"], ["payouts", "Payouts"], ["verification", "Verification documents"], ["promote", "Promoting my event"], ["cashless", "Cashless and vendors"], ["account", "My organiser account"], ["other", "Something else"]],
};
async function contact() {
  const params = new URLSearchParams(location.search);
  const partnershipMode = params.get("topic") === "partnership";
  document.title = partnershipMode ? "Partnership enquiry | TicketRoom" : "Contact us | TicketRoom";
  const [site, u] = await Promise.all([siteInfo(), me()]);
  const resp = site?.support?.responseTime || "24–48 hours";
  let audience = partnershipMode || params.get("as") === "organiser" || params.get("topic") === "organiser" || u?.account_type === "organiser" ? "organiser" : "customer";
  render(main, html`<div class="wrap section stack-lg"><div><h1>${partnershipMode ? "Partnership enquiry" : "Contact us"}</h1><p class="lead mb-0">${partnershipMode ? `Tell us about your organisation and the partnership you have in mind. We’ll email you a reference and reply within ${resp}.` : `Tell us what you need and we'll reply within ${resp}.`}</p></div>
    <div class="grid-2 contact-grid"><section class="card stack">
      <div class="tabs" role="tablist" aria-label="I am a" data-audience-tabs ${raw(partnershipMode ? "hidden" : "")}>${[["customer", "Customer"], ["organiser", "Event organiser"]].map(([k, l]) => html`<button type="button" role="tab" data-aud="${k}" aria-selected="${audience === k}">${l}</button>`)}</div>
      <form class="stack" id="ctf" novalidate>
        <div class="grid-2"><div class="field"><label for="ct-name">Name</label><input id="ct-name" name="fullName" autocomplete="name" required maxlength="120" value="${u?.full_name || ""}"></div>
          <div class="field"><label for="ct-email">Email</label><input id="ct-email" name="email" type="email" autocomplete="email" required value="${u?.email || ""}"></div></div>
        <div class="grid-2" data-partner-fields hidden><div class="field"><label for="ct-company">Organisation or business</label><input id="ct-company" name="companyName" maxlength="160" autocomplete="organization" placeholder="Name of your organisation or business"></div>
          <div class="field"><label for="ct-partner-type">Partnership type</label><select id="ct-partner-type" name="partnerType"><option value="">Choose a partnership type</option><option value="event-organiser">Event organiser or promoter</option><option value="venue">Venue or entertainment space</option><option value="artist-brand">Artist or entertainment brand</option><option value="corporate-institution">Corporate or institution</option><option value="technology-commercial">Technology or commercial partner</option><option value="other">Other</option></select></div></div>
        <div class="grid-2" data-partner-profiles hidden><div class="field"><label for="ct-website">Website <span class="muted">(optional)</span></label><input id="ct-website" name="website" type="url" maxlength="300" placeholder="https://yourwebsite.co.za"></div>
          <div class="field"><label for="ct-social-handle">Social handle <span class="muted">(optional)</span></label><input id="ct-social-handle" name="socialHandle" maxlength="60" placeholder="@yourhandle"></div></div>
        <div class="field" data-partner-timeline hidden><label for="ct-partner-timeline">When are you looking to work together? <span class="muted">(optional)</span></label><select id="ct-partner-timeline" name="partnerTimeline"><option value="">Choose a timeframe</option><option value="within-1-month">Within a month</option><option value="1-3-months">In 1–3 months</option><option value="3-6-months">In 3–6 months</option><option value="exploring">Just exploring</option></select></div>
        <div class="grid-2"><div class="field" data-event-field><label for="ct-event" data-event-label>Event <span class="muted">(optional)</span></label><input id="ct-event" name="eventName" maxlength="160" autocomplete="off" placeholder="Enter the event name, if relevant"></div>
          <div class="field" data-query-field><label for="ct-type">Type of query</label><select id="ct-type" name="queryType" required></select></div></div>
        <div class="field" data-ref-field><label for="ct-ref">Order reference or wristband number <span class="muted">(if you have one)</span></label><input id="ct-ref" name="reference" maxlength="40" autocapitalize="characters" placeholder="TR-ABCD1234"><span class="hint">Your order reference is in your confirmation email. The wristband number is printed on the band.</span></div>
        <div class="field"><label for="ct-phone">Mobile number <span class="muted">(optional)</span></label><input id="ct-phone" name="phone" type="tel" autocomplete="tel" maxlength="30"></div>
        <div class="field"><label for="ct-msg" data-message-label>${partnershipMode ? "Your partnership proposal" : "Your query"}</label><textarea id="ct-msg" name="message" required maxlength="4000" rows="5" placeholder="${partnershipMode ? "Tell us what you have in mind, who it is for, the value it could create and any timing or next steps." : ""}"></textarea>${partnershipMode ? html`<span class="hint">A little context helps us route your enquiry to the right person.</span>` : ""}</div>
        <button class="btn btn-primary">Send</button>
        <p class="tiny muted mb-0">We use these details only to answer you. See our <a href="/legal/privacy">Privacy Policy</a>.</p></form></section>
      <section class="card stack"><h2>Other ways to reach us</h2>
        ${site ? html`<p class="callout ${site.hours.openNow ? "good" : "warn"} mb-0"><strong>${hoursText(site.hours)}.</strong></p>` : ""}
        <p class="mb-0">Use the form to send your message. We'll email you a reference and confirmation.</p>
        <p class="mb-0"><a class="row" style="gap:6px;display:inline-flex" href="${INSTAGRAM}" target="_blank" rel="noopener">${svgIcon("instagram", 18)} Instagram: @ticketroom_za</a></p>
        <p class="mb-0"><a class="row" style="gap:6px;display:inline-flex" href="${X_SOCIAL}" target="_blank" rel="noopener">${svgIcon("x", 18)} X: @ticketroom_za</a></p>
        <p class="mb-0"><a class="row" style="gap:6px;display:inline-flex" href="${FACEBOOK_SOCIAL}" target="_blank" rel="noopener">${svgIcon("facebook", 18)} Facebook: @ticketroom.za</a></p>
        <button type="button" class="btn btn-ghost" data-callback ${raw(partnershipMode ? "hidden" : "")}>Rather have us call you?</button>
        ${site?.chatbot?.enabled && !site?.maintenance ? html`<button class="btn btn-ghost" data-open-chat>Ask the assistant now</button>` : ""}
        <h3>Office hours</h3>${site ? weekTable(site.hours) : html`<p>Monday to Friday, 9am to 5pm. Closed on weekends and public holidays.</p>`}
        <p class="small muted mb-0">Messages received after hours, on weekends or public holidays are answered on the next working day.</p></section></div></div>`);
  const f = $("#ctf");
  const setAudience = (a) => {
    if (partnershipMode) a = "organiser";
    audience = a;
    $$("[data-aud]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.aud === a)));
    render($("#ct-type"), html`<option value="">Choose one</option>${CONTACT_TYPES[a].map(([v, l]) => html`<option value="${v}">${l}</option>`)}`);
    $("[data-ref-field]").hidden = a !== "customer";
  };
  $$("[data-aud]").forEach((b) => b.addEventListener("click", () => setAudience(b.dataset.aud)));
  setAudience(audience);
  if (audience === "organiser" && params.get("topic") === "partnership") $("#ct-type").value = "partnership";
  const updatePartnershipFields = () => {
    const partnership = partnershipMode || (audience === "organiser" && $("#ct-type").value === "partnership");
    $("[data-audience-tabs]").hidden = partnershipMode;
    $("[data-partner-fields]").hidden = !partnership;
    $("[data-partner-profiles]").hidden = !partnership;
    $("[data-partner-timeline]").hidden = !partnership;
    $("[data-event-field]").hidden = false;
    $("[data-query-field]").hidden = partnership;
    $("[data-ref-field]").hidden = partnership || audience !== "customer";
    $("[data-callback]").hidden = partnership;
    $("[data-message-label]").textContent = partnership ? "Your partnership proposal" : "Your query";
    $("[data-event-label]").textContent = partnership ? "Event or project (optional)" : "Event (optional)";
    $("#ct-event").placeholder = partnership ? "Name the event, campaign or project" : "Enter the event name, if relevant";
    $("#ct-msg").placeholder = partnership ? "Tell us what you have in mind, who it is for, the value it could create and any timing or next steps." : "";
    $("#ct-company").required = partnership;
    $("#ct-partner-type").required = partnership;
  };
  $$("[data-aud]").forEach((b) => b.addEventListener("click", updatePartnershipFields));
  $("#ct-type").addEventListener("change", updatePartnershipFields);
  updatePartnershipFields();
  $("[data-callback]").addEventListener("click", () => callbackDialog({ topic: audience === "organiser" ? "organiser" : "callback" }));
  onSubmit(f, async (v) => {
    const r = await post("/api/site/contact", { audience, fullName: v.fullName, email: v.email, phone: v.phone || undefined, queryType: v.queryType,
      companyName: v.companyName || undefined, partnerType: v.partnerType || undefined, website: v.website || undefined, socialHandle: v.socialHandle || undefined, partnerTimeline: v.partnerTimeline || undefined,
      eventName: v.eventName || undefined, reference: audience === "customer" && v.reference ? v.reference : undefined, message: v.message });
    render(f, html`<div class="callout good"><strong>Thanks, we've got it.</strong> Your reference is <strong>${r.reference}</strong>. We'll reply within ${r.responseTime}. A copy is on its way to your email.</div>`);
  });
  wireSupport(main);
}

// ---------------- PayFast hand-over ----------------
// PayFast takes payment on its own page, reached by posting a signed form.
// This page fetches that form from TicketRoom and sends the buyer on.
async function payPage() {
  const q = new URLSearchParams(location.search);
  if (q.get("m") === "sandbox") return sandboxPayPage(q);
  document.title = "Taking you to PayFast | TicketRoom";
  render(main, html`<div class="wrap section"><section class="welcome card center"><span class="tk-label">Secure payment</span><h1>Taking you to PayFast…</h1><p class="lead">You'll pay on PayFast's secure page, then come straight back to your tickets.</p>${spinner()}</section></div>`);
  try {
    const f = await get(`/api/public/payments/${encodeURIComponent(q.get("p") || "")}/payfast?k=${encodeURIComponent(q.get("k") || "")}`);
    const form = document.createElement("form");
    form.method = "post"; form.action = f.action; form.hidden = true;
    for (const [k, v] of Object.entries(f.fields)) { const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; form.append(i); }
    document.body.append(form);
    form.submit();
  } catch (err) {
    render(main, html`<div class="wrap section"><section class="welcome card"><span class="tk-label">Payment</span><h1>We couldn't open the payment page</h1><p class="lead">${err.message}</p><a class="btn btn-primary" href="/">Back to events</a></section></div>`);
  }
}

// ---------------- sandbox payment ----------------
// Practice payments while TicketRoom is in sandbox mode. The buyer picks what
// the "bank" answers; the answer takes the same path as a real provider's
// notification. Tickets bought here are marked TEST and refused at the gate.
async function sandboxPayPage(q) {
  document.title = "Practice payment | TicketRoom";
  const id = encodeURIComponent(q.get("p") || ""), k = q.get("k") || "";
  const fail = (msg) => render(main, html`<div class="wrap section"><section class="welcome card"><span class="tk-label">Practice payment</span><h1>We couldn't open the payment page</h1><p class="lead">${msg}</p><a class="btn btn-primary" href="/">Back to events</a></section></div>`);
  let d;
  try { d = await get(`/api/public/payments/${id}/sandbox?k=${encodeURIComponent(k)}`); } catch (err) { return fail(err.message); }
  if (d.payment.status !== "pending") { location.replace(d.returnUrl); return; }
  const promo = d.purpose === "promotion";
  render(main, html`<div class="wrap section"><section class="sandbox-pay card">
    <p class="sandbox-flag" role="note"><strong>Sandbox</strong> Practice payment. No real money moves and no card is charged.</p>
    <span class="tk-label">Pay TicketRoom</span>
    <h1 class="mb-0">${moneyExact(d.payment.amountCents)}</h1>
    <p class="muted">${promo ? `Promote package for ${d.order.title} · ${d.order.reference}` : `${d.order.title} · Order ${d.order.reference}`}</p>
    <div class="sandbox-card" aria-hidden="true"><span>TEST CARD</span><b>4242 4242 4242 4242</b><span>${d.order.buyer_name || "Practice buyer"} · 12/30</span></div>
    <p class="small">${promo ? html`Choose what the bank says. A Promote package from an approved practice payment is marked <strong>TEST</strong> and never counts as revenue.` : html`Choose what the bank says. Tickets from an approved practice payment are marked <strong>TEST</strong> and will not open the gate.`}</p>
    <div class="stack">
      <button class="btn btn-primary btn-block" data-outcome="paid">Approve payment</button>
      <button class="btn btn-ghost btn-block" data-outcome="failed">Decline (card refused)</button>
      <button class="btn btn-ghost btn-block" data-outcome="cancelled">Cancel and go back</button>
    </div></section></div>`);
  $$("[data-outcome]").forEach((b) => b.addEventListener("click", async () => {
    $$("[data-outcome]").forEach((x) => { x.disabled = true; });
    b.setAttribute("aria-busy", "true");
    try { const r = await post(`/api/public/payments/${id}/sandbox`, { k, outcome: b.dataset.outcome }); location.replace(r.returnUrl); }
    catch (err) { toast(err.message, "bad"); $$("[data-outcome]").forEach((x) => { x.disabled = false; }); b.removeAttribute("aria-busy"); }
  }));
}

// ---------------- gate pass ----------------
// Crew, artists, media and guests open their pass from the private link the
// organiser sent. No account needed; the link is the key, so it is not indexed.
async function passPage() {
  document.title = "Gate pass | TicketRoom";
  const t = new URLSearchParams(location.search).get("t") || "";
  let r;
  try { r = await get(`/api/public/pass?t=${encodeURIComponent(t)}`); }
  catch (err) { render(main, html`<div class="wrap section"><div class="tk-wrap"><div class="card"><h1>Pass not found</h1><p class="mb-0">${err.message}</p></div></div></div>`); return; }
  const { pass: g, event: e, svg } = r;
  const when = `${fmtDate(e.starts_at, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, ${fmtTime(e.starts_at)}`;
  const place = [e.venue_name, e.city].filter(Boolean).join(", ");
  const rows = [["Pass", g.role], ["Name", g.holderName], ...(g.accessNote ? [["Access", g.accessNote]] : []), ["Entry", g.reentry ? "In and out" : "One entry"]];
  const live = g.status === "active" && svg;
  render(main, html`<div class="wrap section"><div class="tk-wrap">
    ${!live ? html`<p class="callout bad mb-0">This pass was cancelled or replaced by the organiser. Ask them for your current pass.</p>` : g.used ? html`<p class="callout warn mb-0">This one-entry pass has already been scanned.</p>` : ""}
    <article class="ticket ${live ? "" : "void"}" aria-label="Gate pass ${g.code}">
      <header class="tk-head"><span class="tk-label">Gate pass</span><h3>${e.title}</h3><p class="tk-when">${when}</p><p class="tk-where">${place}</p></header>
      <div class="tk-body"><dl class="tk-rows">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
        <div class="t-qr">${live ? raw(svg.replace("<svg ", '<svg role="img" aria-label="Gate pass QR code" width="220" height="220" ')) : html`<span class="stamp muted">cancelled</span>`}</div>
        <p class="tk-scan">${live ? "Scan at the gate" : ""}</p></div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-foot"><span class="tk-label">Pass code</span><span class="tk-code">${g.code}</span>
        <p class="tk-note">Issued by ${e.organiser}. Keep this link private: anyone with it can use your pass.</p></div>
    </article>
    ${live ? html`<div class="tk-actions no-print"><div class="row"><button class="btn btn-ghost btn-sm" data-img>Save pass image</button><button class="btn btn-ghost btn-sm" data-print>Print</button></div></div>` : ""}
  </div></div>`);
  $("[data-print]")?.addEventListener("click", () => window.print());
  $("[data-img]")?.addEventListener("click", async () => {
    try {
      const png = await ticketPng(svg, { label: "GATE PASS", title: e.title, when, place, rows, code: g.code, codeLabel: "PASS CODE", note: "Show this pass at the gate. Keep it private." });
      const a = document.createElement("a"); a.href = URL.createObjectURL(png); a.download = `gate-pass-${g.code}.png`; document.body.append(a); a.click(); a.remove();
      toast("Saved to your downloads. Show it at the gate if you have no signal.", "good");
    } catch (err) { toast(err.message, "bad"); }
  });
}

// ---------------- unsubscribe ----------------
function unsubscribe() {
  document.title = "Unsubscribe | TicketRoom";
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
// This page says when it is ready (after its content has loaded), so it
// appears in one go instead of jumping about on a slow connection.
document.documentElement.dataset.manualReady = "1";
(async () => {
  const ALIAS = { "/privacy": "/legal/privacy", "/cookies": "/legal/cookies", "/terms": "/legal/terms", "/legal/refunds": "/legal/terms" };
  if (ALIAS[location.pathname]) history.replaceState(null, "", ALIAS[location.pathname] + location.hash);
  await header($("#header"), { active: ["/sell", "/help", "/safety", "/", "/about", "/partners", "/careers"].includes(location.pathname) ? location.pathname : location.pathname === "/contact" ? "/help" : null });
  footer($("#footer"));
  const p = location.pathname;
  try {
    let m;
    if ((m = p.match(/^\/events\/([^/]+)(\/tickets)?$/))) await eventPage(decodeURIComponent(m[1]), { tickets: !!m[2] });
    else if ((m = p.match(/^\/orders\/([^/]+)$/))) await orderPage(decodeURIComponent(m[1]));
    else if ((m = p.match(/^\/legal\/([a-z-]+)$/))) await legal(m[1]);
    else if (p === "/about") await aboutPage();
    else if (p === "/partners") await partnersPage();
    else if (p === "/safety") await safetyPage();
    else if (p === "/careers") await careersPage();
    else if (p === "/sell") sellPage();
    else if (p === "/advertise") await advertisePage();
    else if (p === "/subscribe") await subscribePage();
    else if (p === "/help") await help();
    else if (p === "/contact") await contact();
    else if (p === "/unsubscribe") unsubscribe();
    else if (p === "/pass") await passPage();
    else if (p === "/pay") await payPage();
    else if (p === "/" || p === "/browse") await home();
    else if (p === "/signin") {
      // Staff land in the admin portal, organisers in the organiser portal, everyone else in the customer portal.
      const { authDialog, homePortal } = await import("/assets/core.js");
      const u = await me();
      if (u) { location.replace(homePortal(u)); return; }
      await home();
      authDialog("signin", { onDone: async () => { location.href = homePortal(await me(true)); } });
    }
    else render(main, html`<div class="wrap section"><div class="card pad-lg"><h1>Page not found</h1><a class="btn btn-primary" href="/">Browse events</a></div></div>`);
  } catch (err) {
    render(main, html`<div class="wrap section"><div class="card pad-lg"><h1>${err.status === 404 ? "Not found" : "Something went wrong"}</h1><p>${err.message}</p><a class="btn btn-primary" href="/">Browse events</a></div></div>`);
  } finally {
    pageReady();
  }
})();
