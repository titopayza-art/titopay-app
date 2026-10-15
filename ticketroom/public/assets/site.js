import { appConfig, html, raw, render, $, $$, get, post, money, moneyExact, fmtDate, fmtTime, fmtDateTime, dayNum, monShort, header, footer, poster, requireUser, authDialog, me, toast, onSubmit, idem, badge, empty, spinner, esc, siteInfo, callbackFields, callbackDialog, hoursText, weekTable, features, subscribeForm, pageReady, likeButton, shareBar, svgIcon, INSTAGRAM, calendarFile, AGE_GROUPS, TICKET_KINDS, ageGroupText, ticketPng, organiserSignupDialog, dialog, consent } from "/assets/core.js";
import { documents, ORDER, VERSION, EFFECTIVE } from "/assets/legal.js";

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
      <div class="feature-rail" id="featured" aria-label="Featured events"></div>
    </div></section>
    <section class="section"><div class="wrap">
      <div class="row between events-head"><h2 class="mb-0">Upcoming events</h2>
        <button type="button" class="btn btn-ghost filter-btn" data-filters><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Filters<span class="filter-count" data-fcount hidden></span></button></div>
      <div class="chips mt" role="group" aria-label="Quick filters">${[["today", "Today"], ["weekend", "This weekend"], ["week", "Next 7 days"]].map(([v, l]) => html`<button class="chip" data-when="${v}" aria-pressed="${state.when === v}">${l}</button>`)}<button class="chip" data-free aria-pressed="${state.free === "1"}">Free</button>${CATS.filter(([v]) => v).slice(0, 5).map(([v, l]) => html`<button class="chip" data-cat="${v}" aria-pressed="${state.categories.split(",").includes(v)}">${l}</button>`)}</div>
      <div class="active-filters mt" data-active aria-live="polite"></div>
      <div class="event-grid mt" id="grid" aria-live="polite">${spinner()}</div>
    </div></section>
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
      <div class="row"><a class="btn btn-primary" href="/sell">Start selling</a><a class="btn btn-outline-light" href="/organisers">Organiser login</a></div>
    </div></div></section>
    <section class="section pt-0"><div class="wrap"><div class="ad-band">
      <div><span class="cat-label">Advertising</span><h2>Advertise your business on TicketRoom</h2>
        <p class="mb-0">Get a spot today from as little as <strong>R50 per day</strong>. Your poster sits in front of people planning their next night out.</p></div>
      <a class="btn btn-primary" href="/advertise">Get a spot</a>
    </div></div></section>`);

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
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString();
    history.replaceState(null, "", qs ? `/?${qs}` : "/");
    syncQuick();
    const { events, cities } = await get(`/api/public/events?${filterQuery(state)}`);
    const sel = $("#city");
    if (sel.options.length === 1) cities.forEach((c) => { const o = new Option(`${c.city} (${c.n})`, c.city); sel.add(o); });
    sel.value = state.city;
    render($("#grid"), events.length ? html`${events.map(card)}` : html`<div class="empty-filters card flat center"><h3>No events match those filters</h3><p class="muted">Try a wider distance, other dates, or fewer filters.</p><button type="button" class="btn btn-primary" data-filters-again>Change filters</button></div>`);
    $("[data-filters-again]")?.addEventListener("click", () => filtersSheet(state, load));
    if (!filterChips(state).length && !state.q) {
      const feat = events.filter((e) => e.featured).slice(0, 6);
      render($("#featured"), html`${(feat.length ? feat : events.slice(0, 4)).map((e) => html`<a class="feature" href="/events/${e.slug}">${poster(e)}<span class="shade"></span><div class="meta"><span class="badge amber plain">${fmtDate(e.starts_at, { weekday: "short", day: "numeric", month: "short" })}</span><h3>${e.title}</h3><span class="small">${e.venue_name}, ${e.city} · ${e.from_price_cents === 0 ? "Free" : `from ${money(e.from_price_cents)}`}</span></div></a>`)}`);
    } else render($("#featured"), "");
  };
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
    const ads = (site?.posters || []).filter((a) => a.placement !== "event");
    if (!ads.length) return;
    $("#ads").classList.remove("hidden");
    render($("#ad-rail"), html`${ads.map((a) => html`<a class="ad-poster" href="${a.link_url || "#"}" data-ad="${a.id}" ${raw(/^https?:/i.test(a.link_url || "") ? 'target="_blank" rel="noopener sponsored"' : "")}>
      ${a.image_upload_id ? html`<img src="/media/${a.image_upload_id}" alt="${a.title}" loading="lazy">` : ""}<span class="sponsored">Featured</span>
      <div class="meta"><h3>${a.title}</h3>${a.subtitle ? html`<span>${a.subtitle}</span>` : ""}</div></a>`)}`);
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
  await load();
}

// ---------------- event page + checkout ----------------
async function eventPage(slug) {
  const pv = new URLSearchParams(location.search).get("preview");
  const [{ event: e, ticketTypes }, cfg] = await Promise.all([get(`/api/public/events/${encodeURIComponent(slug)}${pv ? `?preview=${encodeURIComponent(pv)}` : ""}`), get("/api/config")]);
  // Previews are private: keep them out of search engines.
  if (e.preview) { const m = document.createElement("meta"); m.name = "robots"; m.content = "noindex"; document.head.append(m); }
  document.title = `${e.title} | TicketRoom`;
  const ref = new URLSearchParams(location.search).get("ref");
  // The organiser link that brought the buyer here: kept for later visits only with functional consent.
  if (ref) { if (consent("functional")) { try { sessionStorage.setItem(`tr_ref_${slug}`, ref); } catch { /* private mode */ } } post(`/api/public/events/${slug}/click`, { ref }).catch(() => {}); }
  const qty = Object.fromEntries(ticketTypes.map((t) => [t.id, 0]));
  const closed = !e.salesOpen;
  const lineup = Array.isArray(e.lineup) ? e.lineup : [];
  const place = [e.venue_name, e.address, e.city, e.province].filter(Boolean).join(", ");
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
  const day = (d) => fmtDate(d, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const tabs = [["info", "Info"], ...(lineup.length ? [["lineup", "Line up"]] : []), ["venue", "Venue"]];
  render(main, html`
    ${e.preview ? html`<div class="preview-bar" role="note"><div class="wrap row between"><span><strong>Preview.</strong> Only people with this link can see this page. Tickets go on sale once it is published.</span>
      ${e.previewOrganiserId ? html`<a class="btn btn-sm btn-primary" href="/organisers#/events/${e.id}">Back to publish</a>` : ""}</div></div>` : ""}
    <section class="event-hero">${poster(e)}<span class="shade"></span><div class="wrap">
      <div class="crumbs"><a href="/">Events</a> › <a href="/?category=${e.category}">${e.category}</a></div>
      <span class="cat-badge">${e.category}</span><h1>${e.title}</h1>
      ${e.summary ? html`<p class="lead">${e.summary}</p>` : ""}
      <div class="event-facts"><span>${icon("calendar")}${day(e.starts_at)}${dayNum(e.starts_at) === dayNum(e.ends_at) && monShort(e.starts_at) === monShort(e.ends_at) ? "" : ` to ${day(e.ends_at)}`}</span>
        <span>${icon("clock")}${fmtTime(e.starts_at)} to ${fmtTime(e.ends_at)} SAST${e.doors_open_at ? ` · doors ${fmtTime(e.doors_open_at)}` : ""}</span>
        <a class="event-place" href="${mapUrl}" target="_blank" rel="noopener">${icon("pin")}${place}</a></div>
      <div class="row mt"><a class="btn btn-primary" href="#box" data-buy>${e.is_free ? "Get free tickets" : "Buy tickets"}</a><div class="event-actions" data-actions></div></div>
      ${e.cashless_enabled ? html`<div class="cashless-note" role="note"><div class="cl-head"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 7.5a6.5 6.5 0 0 1 0 9M12.5 5a10 10 0 0 1 0 14M5.5 10a2.8 2.8 0 0 1 0 4"/></svg>
        <strong>This event is cashless!</strong></div><p class="mb-0">No cash at the bars and food stalls. Tap your wristband to pay and top up on your phone.</p>
        <button type="button" class="btn cl-more" data-cashless>More info</button></div>` : ""}
      ${e.status === "cancelled" ? html`<p class="callout bad mt"><strong>This event has been cancelled.</strong> Ticket holders are refunded automatically.</p>` : ""}
    </div></section>
    <div class="wrap event-layout">
      <div class="stack-lg">
        <div class="tabs event-tabs" role="tablist">${tabs.map(([k, l], i) => html`<button type="button" role="tab" id="tab-${k}" aria-controls="panel-${k}" aria-selected="${i === 0}" data-tab="${k}">${l}</button>`)}</div>
        <div role="tabpanel" id="panel-info" aria-labelledby="tab-info" class="stack-lg">
          <section class="card"><h2>About this event</h2><div class="prose">${e.description || e.summary || ""}</div></section>
          ${e.accessibility_info ? html`<section class="card"><h2>Accessibility</h2><p class="prose mb-0">${e.accessibility_info}</p></section>` : ""}
          <section class="card"><h2>Good to know</h2><dl class="dl">
            <dt>Organiser</dt><dd>${e.organiser_name}${e.organiser_ref ? html` <span class="small muted mono nowrap">${e.organiser_ref}</span>` : ""}</dd>
            ${e.ref ? html`<dt>Event ID</dt><dd class="mono">${e.ref}</dd>` : ""}
            ${e.age_groups ? html`<dt>Made for</dt><dd>${ageGroupText(e.age_groups)}</dd>` : ""}
            ${e.age_restriction ? html`<dt>Age</dt><dd>${e.age_restriction}</dd>` : ""}
            <dt>Transfers</dt><dd>${e.transfers_enabled ? "Free ticket transfers until the event starts" : "Tickets are not transferable"}</dd>
            ${e.cashless_enabled ? html`<dt>Cashless</dt><dd>This is a cashless event. Link a wristband and top up in your account.</dd>` : ""}
            <dt>Refunds</dt><dd>${e.refund_policy}</dd></dl></section>
        </div>
        ${lineup.length ? html`<div role="tabpanel" id="panel-lineup" aria-labelledby="tab-lineup" hidden><section class="card"><h2>Line up</h2>
          <ol class="lineup">${lineup.map((a, i) => html`<li class="${i === 0 ? "headliner" : ""}">${a.time ? html`<span class="lineup-time">${a.time}</span>` : ""}<a href="/?q=${encodeURIComponent(a.name)}">${a.name}</a></li>`)}</ol></section></div>` : ""}
        <div role="tabpanel" id="panel-venue" aria-labelledby="tab-venue" hidden><section class="card stack"><h2>Venue</h2>
          <p class="mb-0"><strong>${e.venue_name}</strong><br>${e.address ? html`${e.address}<br>` : ""}${e.city}${e.province ? `, ${e.province}` : ""}</p>
          ${e.doors_open_at ? html`<p class="mb-0">Doors open at <strong>${fmtTime(e.doors_open_at)}</strong> SAST.</p>` : ""}
          <div class="row"><a class="btn btn-ghost btn-sm" href="${mapUrl}" target="_blank" rel="noopener">Open in Maps</a><a class="btn btn-ghost btn-sm" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}" target="_blank" rel="noopener">Directions</a></div></section></div>
      </div>
      <aside class="card ticket-box" id="box" aria-labelledby="tix-h"></aside>
    </div>`);
  // Info / Line up / Venue tabs, keyboard friendly.
  const tabBtns = $$("[data-tab]");
  const showTab = (k) => tabBtns.forEach((b) => { const on = b.dataset.tab === k; b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1; $(`#panel-${b.dataset.tab}`).hidden = !on; });
  tabBtns.forEach((b, i) => {
    b.addEventListener("click", () => showTab(b.dataset.tab));
    b.addEventListener("keydown", (ev) => { const d = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0; if (!d) return; const n = tabBtns[(i + d + tabBtns.length) % tabBtns.length]; n.focus(); showTab(n.dataset.tab); });
  });
  showTab("info");
  $("[data-buy]").addEventListener("click", (ev) => { ev.preventDefault(); $("#box").scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("[data-cashless]")?.addEventListener("click", () => {
    dialog(`Cashless at ${e.title}`, html`<div class="stack"><p>No cash or cards at the bars and food stalls. You pay with your wristband instead.</p>
      <ol class="stack small"><li>Buy your ticket, then link your wristband in your TicketRoom account (the code is printed on the band).</li><li>Top up by card before or during the event. Your balance is safe in your account.</li><li>Tap to pay at any stall. Purchases above a set amount need your PIN.</li><li>Lost your wristband? Block it in your account straight away and move your balance to a new one.</li><li>Money left over after the event can be refunded from your account.</li></ol>
      <div class="row end"><button class="btn btn-primary" data-close>Got it</button></div></div>`);
  });

  const eventUrl = `${location.origin}/events/${e.slug}`;
  const cal = document.createElement("button");
  cal.type = "button"; cal.className = "pill-btn"; cal.textContent = "Add to calendar";
  cal.addEventListener("click", () => calendarFile({ title: e.title, starts: e.starts_at, ends: e.ends_at, place: [e.venue_name, e.address, e.city].filter(Boolean).join(", "), url: eventUrl }));
  $("[data-actions]").append(likeButton(e.slug, { liked: e.liked, likes: e.likes }), cal, shareBar(eventUrl, e.title, { text: `${e.title}, ${fmtDate(e.starts_at, { day: "numeric", month: "long" })} at ${e.venue_name}` }));
  const box = $("#box");
  const selection = () => ticketTypes.filter((t) => qty[t.id] > 0).map((t) => ({ ticketTypeId: t.id, quantity: qty[t.id] }));
  const drawSelect = () => {
    const count = Object.values(qty).reduce((a, b) => a + b, 0);
    const sub = ticketTypes.reduce((s, t) => s + t.price_cents * qty[t.id], 0);
    const fee = ticketTypes.reduce((s, t) => s + t.fee_cents * qty[t.id], 0);
    render(box, html`<h2 id="tix-h">Tickets</h2>
      ${closed ? html`<p class="callout warn">${e.preview ? "Preview only. Tickets go on sale once the event is published." : e.status === "cancelled" ? "Sales are closed." : "Ticket sales are not open right now."}</p>` : ""}
      ${ticketTypes.length ? ticketTypes.map((t) => html`<div class="tt"><div class="info"><div class="name">${t.name}</div>
          <div class="meta">${t.price_cents === 0 ? "Free" : html`${moneyExact(t.price_cents)} <span>+ ${moneyExact(t.fee_cents)} booking fee</span>`}${t.remaining === 0 ? " · Sold out" : t.remaining < 25 ? ` · Only ${t.remaining} left` : ""}</div>
          ${t.admits > 1 || TICKET_KINDS[t.kind]?.note ? html`<div class="meta">${[t.admits > 1 ? `Admits ${t.admits} people` : "", TICKET_KINDS[t.kind]?.note || ""].filter(Boolean).join(" · ")}</div>` : ""}
          ${t.description ? html`<div class="meta">${t.description}</div>` : ""}</div>
        <div class="stepper" role="group" aria-label="${t.name} quantity"><button data-dec="${t.id}" aria-label="Fewer ${t.name}" ${raw(qty[t.id] === 0 ? "disabled" : "")}>−</button><output aria-live="polite">${qty[t.id]}</output><button data-inc="${t.id}" aria-label="More ${t.name}" ${raw(closed || qty[t.id] >= Math.min(t.per_order_limit, t.remaining) ? "disabled" : "")}>+</button></div></div>`) : html`<p class="muted">No tickets available.</p>`}
      <div class="totals"><div class="line"><span>${count} ticket${count === 1 ? "" : "s"}</span><span>${moneyExact(sub)}</span></div>
        <div class="line"><span>Booking fee</span><span>${moneyExact(fee)}</span></div>
        <div class="line total"><span>Total</span><span>${moneyExact(sub + fee)}</span></div></div>
      ${!cfg.cardPaymentsEnabled && sub > 0 ? html`<p class="callout warn mt">Paid tickets go on sale soon. Free tickets are available now.</p>` : ""}
      <button class="btn btn-primary btn-block mt" data-continue ${raw(count === 0 || closed || (!cfg.cardPaymentsEnabled && sub > 0) ? "disabled" : "")}>Continue</button>
      <p class="trust mt mb-0">${e.is_free ? "This event is free. Choose how many tickets you need and register." : html`${icon("lock")}The only extra is a R10 booking fee per paid ticket. Got a promo code? Add it on the next step.`}</p>`);
    $$("[data-inc]", box).forEach((b) => b.addEventListener("click", () => { qty[b.dataset.inc]++; drawSelect(); $(`[data-inc="${b.dataset.inc}"]`, box)?.focus(); }));
    $$("[data-dec]", box).forEach((b) => b.addEventListener("click", () => { qty[b.dataset.dec]--; drawSelect(); $(`[data-dec="${b.dataset.dec}"]`, box)?.focus(); }));
    // No account needed: signed-in people check out as themselves, anyone else as a guest.
    $("[data-continue]", box).addEventListener("click", async () => drawCheckout(await me()));
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
    render(box, html`<div class="steps"><span>Tickets</span><span aria-current="step">Checkout</span><span>Payment</span></div>
      <h2 id="tix-h">Checkout</h2>
      <div class="totals">${quote.lines.map((l) => html`<div class="line"><span>${l.quantity} × ${l.name}</span><span>${moneyExact(l.unitPriceCents * l.quantity)}</span></div>`)}</div>
      <div class="totals"><div class="line"><span>Subtotal</span><span>${moneyExact(quote.subtotalCents)}</span></div>
        ${quote.discountCents ? html`<div class="line"><span>Promo ${quote.promoCode}</span><span>−${moneyExact(quote.discountCents)}</span></div>` : ""}
        <div class="line"><span>Booking fee</span><span>${moneyExact(quote.feeCents)}</span></div>
        <div class="line total"><span>Total</span><span>${moneyExact(quote.totalCents)}</span></div></div>
      <form class="row mt" id="promo"><label class="sr-only" for="pc">Promo code</label><input id="pc" name="code" placeholder="Promo code" class="grow" value="${quote.promoCode || ""}" maxlength="40"><button class="btn btn-ghost btn-sm">Apply</button></form>
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
      </form>`);
    $("#promo").addEventListener("submit", (ev) => { ev.preventDefault(); drawCheckout(u, $("#pc").value.trim()); });
    $("[data-signin]", box)?.addEventListener("click", () => authDialog("signin", { portal: "customer", onDone: async () => { header($("#header")); drawCheckout(await me(true), promo); } }));
    $("[data-back]", box).addEventListener("click", drawSelect);
    onSubmit($("#pay"), async (v) => {
      if (!u && String(v.gEmail || "").trim().toLowerCase() !== String(v.gEmail2 || "").trim().toLowerCase()) {
        throw Object.assign(new Error("The two email addresses don't match."), { details: { gEmail2: "Must match the email above." } });
      }
      const body = {
        eventSlug: slug, items: selection(), promoCode: quote.promoCode || undefined, ref: ref || sessionStorage.getItem(`tr_ref_${slug}`) || undefined,
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
      const k = res.accessKey ? `?k=${encodeURIComponent(res.accessKey)}` : "";
      if (res.payment?.redirectUrl && res.order.status === "pending_payment") location.href = res.payment.redirectUrl;
      else location.href = `/orders/${res.order.reference}${k}`;
    });
  };
  drawSelect();
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
    const { order: o, items, tickets, payment, guest, email } = await get(`/api/public/orders/${encodeURIComponent(ref)}${q}`);
    const wallet = payment?.method === "titopay_wallet";
    document.title = `Order ${o.reference} | TicketRoom`;
    const pending = o.status === "pending_payment";
    const paid = o.status === "paid" || o.status === "partially_refunded";
    render(main, html`<div class="wrap section stack-lg"><div class="card pad-lg stack" aria-live="polite">
      <div class="row between"><span class="muted small">Order ${o.reference}</span><span class="row">${o.test ? html`<span class="badge warn">Test</span>` : ""}${badge(o.status)}</span></div>
      ${o.test ? html`<p class="callout warn mb-0"><strong>Test order.</strong> This was paid while TicketRoom payments were in test mode. No real money moved, and these tickets will not open the gate.</p>` : ""}
      ${paid ? html`<h1>You're going</h1><p>Your ${tickets.length} ticket${tickets.length === 1 ? " is" : "s are"} ready for <strong>${o.event.title}</strong>. We've emailed them to you as well.</p>
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
        <div class="line"><span>Booking fee</span><span>${moneyExact(o.feeCents)}</span></div><div class="line total"><span>Total</span><span>${moneyExact(o.totalCents)}</span></div>
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
function sellPage() {
  document.title = "List your event | TicketRoom";
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
        <div class="card flat center" data-feature="promote"><div aria-hidden="true">${raw(ic('<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'))}</div><h3 class="mt">Promote</h3><p class="muted mb-0">Email and SMS campaigns to the people who want to hear from you, plus a post on our socials. <span data-promote-price>R1 500</span> once off per event.</p></div>
      </div>
      <section class="card cashless-band" aria-labelledby="cl-h"><div class="grid-2">
        <div class="stack"><span class="cat-label">Cashless events</span><h2 id="cl-h" class="mb-0">Faster bars, bigger spend, no cash to count</h2>
          <p class="mb-0">Turn cashless on for your event and every guest pays with a wristband. Queues move quicker, nothing goes missing, and you see every sale as it happens.</p>
          <ul class="tick-list"><li>Wristbands linked to each guest's ticket and account</li><li>Instant top-up by card before and during the event</li><li>A PIN for bigger purchases, so a found wristband is no use to anyone</li><li>Lost wristband? The guest blocks it in one tap and moves their balance to a new one</li><li>Unused money is refunded to guests after the event, automatically requested</li><li>Vendor sales, commission and settlement worked out for you</li></ul></div>
        <div class="stack"><h3 class="mb-0">How it works</h3>
          <ol class="cl-steps"><li><strong>You</strong> switch on cashless for the event and add your vendors and their menus.</li>
            <li><strong>Guests</strong> collect a wristband at the gate and link it to their ticket by the code printed on it.</li>
            <li><strong>They top up</strong> on their phone in seconds and see their balance and every purchase live.</li>
            <li><strong>Vendors</strong> sell by tapping or scanning the wristband on any phone, no card machine needed.</li>
            <li><strong>After the event</strong> vendors are settled and leftover balances go back to guests.</li></ol>
          <button class="btn btn-primary" data-apply>Plan a cashless event</button></div></div></section>
      <section class="promote-offer" aria-labelledby="pr-h" data-feature="promote"><div class="promote-pitch stack"><span class="tk-label">Promote</span><h2 id="pr-h" class="mb-0">Let your crowd know, loud and clear</h2>
          <p class="mb-0">Our email and SMS campaign tools bring the right people to your event in the right numbers. One payment promotes one event until it ends. No contracts, no per-email charges, no surprises.</p>
          <ul class="promote-ticks"><li><strong>Unlimited email campaigns</strong> to everyone who booked with you and opted in, until your event ends</li><li><strong>SMS campaigns</strong> to the same opted-in crowd</li><li><strong>A post on TicketRoom's socials:</strong> send us your caption and dates, we tell you when it is live</li><li><strong>Clear results:</strong> messages sent, clicks, tickets and revenue for every campaign</li><li><strong>Seamless cashout:</strong> pay by card or straight from your ticket balance</li></ul></div>
        <div class="promote-price"><div class="promote-amount" data-promote-price>R1 500</div><div class="small">once off, per event</div><p class="tiny mb-0">Buy it from your event's Promote tab in the organiser portal, once the event is published or waiting to be published.</p><button class="btn btn-primary btn-block" data-apply>Promote my event</button></div></section>
      <div class="card"><h2>What you get</h2><div class="grid-2">
        <ul><li>A live dashboard of bookings and sales, day by day</li><li>Tracking links, so you know whether Instagram or WhatsApp brought people in</li><li>Email campaigns to people who opted in, with unsubscribe built in (POPIA)</li><li>Ticket transfers that cancel the old QR code, so one ticket can never get two people in</li></ul>
        <ul><li>RFID/NFC wristbands and QR tags for cashless events</li><li>Vendor POS on any phone, with per-vendor reporting</li><li>Refunds with dual approval and a full audit trail</li><li>Payouts to your verified bank account once your event has run</li></ul></div>
      </div>
      <div class="card" id="pricing"><h2>What it costs</h2><div class="grid-3">
        <div><div class="kpi"><div class="k">You pay</div><div class="v">5%</div><div class="s">of ticket sales, deducted from your payout</div></div></div>
        <div><div class="kpi"><div class="k">Your buyers pay</div><div class="v">R10</div><div class="s">booking fee per paid ticket</div></div></div>
        <div><div class="kpi"><div class="k">Free events</div><div class="v">R0</div><div class="s">no fees at all on free events</div></div></div></div>
        <p class="callout mt" data-feature="promote">Promote, optional: <span data-promote-price>R1 500</span> once off per event, everything included until the event ends.</p>
        <p class="callout mt">Cashless: no setup fee. A small commission on vendor sales, agreed per vendor and shown on every settlement. Talk to us about wristbands for your event.</p>
        <p class="muted small mt mb-0">Example: 100 tickets at R150 = R15 000 in sales. You receive R14 250; each buyer pays R160. Payouts are released after your event, less approved refunds.</p></div>
    </div></section>`);
  // New here: account and organisation in one step. Signed in: straight to the organiser portal.
  $$("[data-apply]").forEach((b) => b.addEventListener("click", async () => { if (await me()) location.href = "/organisers"; else organiserSignupDialog(); }));
  // The Promote price comes from the site's settings.
  appConfig().then((c) => { const p = c.promote?.priceCents; if (p) $$("[data-promote-price]").forEach((x) => { x.textContent = moneyExact(p).replace(/\.00$/, ""); }); });
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
  document.title = `${d.title} | TicketRoom`;
  const slug = (i) => `s${i + 1}`;
  render(main, html`<div class="wrap section"><div class="legal-layout">
    <nav class="legal-nav card" aria-label="Legal documents"><h2 class="h4">Legal</h2><ul>${ORDER.map(([k, t]) => html`<li><a href="/legal/${k}" ${raw(k === doc ? 'aria-current="page"' : "")}>${t}</a></li>`)}</ul>
      <p class="tiny muted mt mb-0">Questions? <a href="mailto:${site.support.email}">${site.support.email}</a></p></nav>
    <article class="card pad-lg legal-doc stack">
      <header><h1>${d.title}</h1><p class="legal-meta mb-0">Version ${VERSION} · Effective ${EFFECTIVE}</p></header>
      <p class="lead">${d.summary}</p>
      ${d.important.length ? html`<aside class="legal-important" aria-labelledby="imp-h"><h2 id="imp-h">Please read these clauses carefully</h2><ul>${d.important.map((x) => html`<li>${markup(x)}</li>`)}</ul></aside>` : ""}
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
  ["I paid but have no tickets", "Payment is confirmed by the payment provider, which can take a minute. If nothing shows after 15 minutes, request a callback with your order reference. Please don't pay twice."],
  ["Can I list my event on TicketRoom?", "Yes. Create an organiser account, verify who you are, add your event and press Publish. We check every new event, usually within one working day, and it goes live straight away. Free and paid tickets, and cashless wristbands, are all available."],
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
      <p class="mb-0"><a class="row" style="gap:6px;display:inline-flex" href="${INSTAGRAM}" target="_blank" rel="noopener">${svgIcon("instagram", 18)} Follow us on Instagram: @ticketroom_za</a></p>
      <h3>Office hours</h3>${site ? weekTable(site.hours) : html`<p>Monday to Friday, 9am to 5pm. Closed on weekends and public holidays.</p>`}
      ${site?.hours.upcomingHolidays?.length ? html`<p class="small muted mb-0">Upcoming closures: ${site.hours.upcomingHolidays.map((h) => `${fmtDate(h.date + "T12:00:00+02:00", { day: "numeric", month: "short" })} (${h.name})`).join(", ")}</p>` : ""}
      <p class="small muted mb-0">Requests received after hours, on weekends or public holidays are handled on the next working day.</p>
      ${site?.chatbot?.enabled ? html`<button class="btn btn-ghost" data-open-chat>Ask the assistant now</button>` : ""}</section></div>`;
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
  const u = await me();
  const site = await siteInfo();
  const tile = (t, s) => html`<div class="card flat"><h3>${t}</h3><p class="muted mb-0">${s}</p></div>`;
  render(main, html`<section class="hero"><div class="wrap"><span class="cat-label">Advertising</span><h1>Advertise your business on <b>TicketRoom</b></h1>
      <p class="lead">Get a spot today from as little as R50 per day. Your poster goes in the Featured section of our home page, where people across South Africa come to find their next event.</p>
      <div class="row"><a class="btn btn-primary" href="#get-a-spot">Get a spot</a><a class="btn btn-outline-light" href="mailto:${site?.support?.email || "hello@ticketroom.co.za"}?subject=Advertising%20on%20TicketRoom">Email us</a></div></div></section>
    <section class="section"><div class="wrap stack-lg">
      <div class="grid-3">
        ${tile("Seen by people going out", "Our visitors are planning their weekend: concerts, comedy, sport and festivals. Restaurants, transport, fashion and anything else for a night out fit right in.")}
        ${tile("Your dates, your budget", "Run your poster for a day, a weekend or a whole month. You pay only for the days you choose.")}
        ${tile("One tap to you", "Tapping your poster takes people straight to your website, WhatsApp or booking page.")}
      </div>
      <div class="grid-2">
        <div class="card"><div class="kpi"><div class="k">Featured poster</div><div class="v">From R50</div><div class="s">per day</div></div>
          <p class="small muted mt mb-0">We confirm the price, dates and poster with you before anything goes live. Nothing is charged online.</p></div>
        <div class="card"><h2>How it works</h2><ol class="mb-0">
          <li>Send us your details below.</li>
          <li>We reply within ${site?.support?.responseTime || "24–48 hours"} (Monday to Friday) with a quote and available dates.</li>
          <li>Send us your poster image and the link it should open. It goes live on your first day.</li></ol></div>
      </div>
      <section class="card stack" id="get-a-spot"><h2>Get a spot</h2>
        <form class="stack" id="cbf" novalidate>${callbackFields(u, "advertising", "Business name:\nWhat you'd like to advertise:\nDates you have in mind:")}<button class="btn btn-primary">Send my enquiry</button>
          <p class="tiny muted mb-0">We use these details only to reply to you. See our <a href="/legal/privacy">Privacy Policy</a>.</p></form></section>
    </div></section>`);
  wireSupport(main);
}

const CONTACT_TYPES = {
  customer: [["tickets", "My tickets"], ["order", "Payment or order problem"], ["refund", "Refund"], ["transfer", "Transfer a ticket"], ["cashless", "Cashless or wristband"], ["account", "My account"], ["event", "Question about an event"], ["other", "Something else"]],
  organiser: [["selling", "Selling tickets"], ["setup", "Setting up an event"], ["payouts", "Payouts"], ["verification", "Verification documents"], ["promote", "Promoting my event"], ["cashless", "Cashless and vendors"], ["account", "My organiser account"], ["other", "Something else"]],
};
async function contact() {
  document.title = "Contact us | TicketRoom";
  const params = new URLSearchParams(location.search);
  const [site, u, list] = await Promise.all([siteInfo(), me(), get("/api/public/events").catch(() => ({ events: [] }))]);
  const resp = site?.support?.responseTime || "24–48 hours";
  let audience = params.get("as") === "organiser" || params.get("topic") === "organiser" || u?.account_type === "organiser" ? "organiser" : "customer";
  render(main, html`<div class="wrap section stack-lg"><div><h1>Contact us</h1><p class="lead mb-0">Tell us what you need and we'll reply within ${resp}.</p></div>
    <div class="grid-2 contact-grid"><section class="card stack">
      <div class="tabs" role="tablist" aria-label="I am a">${[["customer", "Customer"], ["organiser", "Event organiser"]].map(([k, l]) => html`<button type="button" role="tab" data-aud="${k}" aria-selected="${audience === k}">${l}</button>`)}</div>
      <form class="stack" id="ctf" novalidate>
        <div class="grid-2"><div class="field"><label for="ct-name">Name</label><input id="ct-name" name="fullName" autocomplete="name" required maxlength="120" value="${u?.full_name || ""}"></div>
          <div class="field"><label for="ct-email">Email</label><input id="ct-email" name="email" type="email" autocomplete="email" required value="${u?.email || ""}"></div></div>
        <div class="grid-2"><div class="field"><label for="ct-event">Event <span class="muted" data-ev-opt>(optional)</span></label><input id="ct-event" name="eventName" list="ct-events" maxlength="160" autocomplete="off" placeholder="Start typing the event name">
            <datalist id="ct-events">${list.events.map((e) => html`<option value="${e.title}">${fmtDate(e.starts_at, { day: "numeric", month: "short" })}, ${e.city}</option>`)}</datalist></div>
          <div class="field"><label for="ct-type">Type of query</label><select id="ct-type" name="queryType" required></select></div></div>
        <div class="field" data-ref-field><label for="ct-ref">Order reference or wristband number <span class="muted">(if you have one)</span></label><input id="ct-ref" name="reference" maxlength="40" autocapitalize="characters" placeholder="TR-ABCD1234"><span class="hint">Your order reference is in your confirmation email. The wristband number is printed on the band.</span></div>
        <div class="field"><label for="ct-phone">Mobile number <span class="muted">(optional)</span></label><input id="ct-phone" name="phone" type="tel" autocomplete="tel" maxlength="30"></div>
        <div class="field"><label for="ct-msg">Your query</label><textarea id="ct-msg" name="message" required maxlength="4000" rows="5"></textarea></div>
        <button class="btn btn-primary">Send</button>
        <p class="tiny muted mb-0">We use these details only to answer you. See our <a href="/legal/privacy">Privacy Policy</a>.</p></form></section>
      <section class="card stack"><h2>Other ways to reach us</h2>
        ${site ? html`<p class="callout ${site.hours.openNow ? "good" : "warn"} mb-0"><strong>${hoursText(site.hours)}.</strong></p>` : ""}
        <p class="mb-0">Email <a href="mailto:${site?.support?.email || "hello@ticketroom.co.za"}">${site?.support?.email || "hello@ticketroom.co.za"}</a></p>
        <p class="mb-0"><a class="row" style="gap:6px;display:inline-flex" href="${INSTAGRAM}" target="_blank" rel="noopener">${svgIcon("instagram", 18)} Instagram: @ticketroom_za</a></p>
        <button type="button" class="btn btn-ghost" data-callback>Rather have us call you?</button>
        ${site?.chatbot?.enabled ? html`<button class="btn btn-ghost" data-open-chat>Ask the assistant now</button>` : ""}
        <h3>Office hours</h3>${site ? weekTable(site.hours) : html`<p>Monday to Friday, 9am to 5pm. Closed on weekends and public holidays.</p>`}
        <p class="small muted mb-0">Messages received after hours, on weekends or public holidays are answered on the next working day.</p></section></div></div>`);
  const f = $("#ctf");
  const setAudience = (a) => {
    audience = a;
    $$("[data-aud]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.aud === a)));
    render($("#ct-type"), html`<option value="">Choose one</option>${CONTACT_TYPES[a].map(([v, l]) => html`<option value="${v}">${l}</option>`)}`);
    $("[data-ref-field]").hidden = a !== "customer";
  };
  $$("[data-aud]").forEach((b) => b.addEventListener("click", () => setAudience(b.dataset.aud)));
  setAudience(audience);
  $("[data-callback]").addEventListener("click", () => callbackDialog({ topic: audience === "organiser" ? "organiser" : "callback" }));
  onSubmit(f, async (v) => {
    const ev = list.events.find((e) => e.title === v.eventName);
    const r = await post("/api/site/contact", { audience, fullName: v.fullName, email: v.email, phone: v.phone || undefined, queryType: v.queryType,
      eventSlug: ev?.slug, eventName: v.eventName || undefined, reference: audience === "customer" && v.reference ? v.reference : undefined, message: v.message });
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
  await header($("#header"), { active: ["/sell", "/help", "/"].includes(location.pathname) ? location.pathname : location.pathname === "/contact" ? "/help" : null });
  footer($("#footer"));
  const p = location.pathname;
  try {
    let m;
    if ((m = p.match(/^\/events\/([^/]+)$/))) await eventPage(decodeURIComponent(m[1]));
    else if ((m = p.match(/^\/orders\/([^/]+)$/))) await orderPage(decodeURIComponent(m[1]));
    else if ((m = p.match(/^\/legal\/([a-z-]+)$/))) await legal(m[1]);
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
