import { html, render, $, get, post, del, header, footer, me, moneyExact, plural, fmtDate, toast, onSubmit, authDialog, emailLinkPage } from "/assets/core.js?build=2026-10-22-phases";
import { boxOfficeApp } from "/assets/boxoffice.js?build=2026-10-22-phases";

const main = $("#main");
let currentUser = null;

function intro() {
  document.title = "Retail ticket partners | TicketRoom";
  render(main, html`<section class="hero"><div class="wrap"><span class="cat-label">Retail partners</span><h1>Tickets, online and in your neighbourhood</h1><p class="lead">Find an approved shop to buy tickets in person, or bring TicketRoom sales to your own shop.</p><div class="row"><a class="btn btn-primary" href="#nearby">Shop at a retailer near you</a><a class="btn btn-ghost" href="#apply">Sell tickets at your shop</a></div></div></section>
    <section class="section pt-0" id="nearby"><div class="wrap"><div class="card pad-lg stack"><span class="cat-label">In-person ticket sales</span><h2>Shop at a retailer near you</h2><p class="small muted mb-0">Browse all approved shops selling tickets in person. Allow location access to sort shops by distance. Your location is used in this page only, not sent to TicketRoom or saved to your account. If you open directions, it is included in the Google Maps link.</p><div class="row"><button class="btn btn-dark" type="button" data-retail-location>Use my location</button><div class="field grow"><label class="sr-only" for="retail-search">Search retailers by name or area</label><input id="retail-search" type="search" placeholder="Search by shop, suburb or town" autocomplete="off"></div></div><p class="small muted mb-0" data-retail-status aria-live="polite">Loading approved retailers…</p><div class="grid-2" data-retail-results aria-live="polite"></div></div></div></section>
    <section class="section"><div class="wrap grid-3"><article class="card stack"><h2>At your counter</h2><p class="mb-0">Take cash, or record a successful Yoco, SnapScan, TitoPay or other terminal payment against a reserved ticket order. Print a till receipt or open the buyer’s ticket page.</p></article>
      <article class="card stack"><h2>Sell online</h2><p class="mb-0">Get a partner link for each event. When a customer checks out through your link, the ticket sale is attributed to your approved shop.</p></article>
      <article class="card stack"><h2>Clear earnings</h2><p class="mb-0">The default partner share is 1.5% of ticket value plus part of the service fee on each paid ticket. It comes from existing fees, not an added buyer charge; free tickets earn no fee share.</p></article></div></section>
    <section class="section pt-0"><div class="wrap"><div class="card pad-lg stack"><span class="cat-label">Printer support</span><h2>Use the printer you already have</h2><p class="mb-0">Print from the browser to common 58 mm or 80 mm receipt printers (including Epson, Star and Bixolon models), or to an ordinary A4 printer. No printer-specific driver or direct hardware integration is required by TicketRoom: choose the connected printer and paper size in your device’s print dialog. Test one ticket before opening sales.</p></div></div></section>
    <section class="section pt-0" id="apply"><div class="wrap"><div id="retail-state" class="card pad-lg stack"></div></div></section>`);
  refreshState();
  loadRetailDirectory();
}

function comingSoon(message = "We are preparing our retail partner programme. Applications and in-store ticket sales will open soon.") {
  document.title = "Retail partners coming soon | TicketRoom";
  render(main, html`<section class="hero" id="nearby"><div class="wrap"><span class="cat-label">Retail partners</span><h1>Retail ticket sales are coming soon</h1><p class="lead">${message}</p></div></section>
    <section class="section pt-0" id="apply"><div class="wrap"><div class="card pad-lg stack"><h2>We’re getting the partner portal ready</h2><p class="muted mb-0">Soon, approved shops will be able to sell TicketRoom tickets in person and online. Applications will open here when the programme is ready.</p><div class="row"><a class="btn btn-primary" href="/contact?as=organiser&topic=partnership">Contact TicketRoom</a><a class="btn btn-ghost" href="/">Browse events</a></div></div></div></section>`);
}

const retailerDistanceKm = (origin, shop) => {
  if (shop.latE6 == null || shop.lngE6 == null) return null;
  const rad = (n) => n * Math.PI / 180;
  const lat = shop.latE6 / 1e6, lng = shop.lngE6 / 1e6;
  const dLat = rad(lat - origin.lat), dLng = rad(lng - origin.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(origin.lat)) * Math.cos(rad(lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

async function loadRetailDirectory() {
  const results = $("[data-retail-results]"), status = $("[data-retail-status]"), locate = $("[data-retail-location]"), search = $("#retail-search");
  if (!results || !status || !locate || !search) return;
  let shops = [], origin = null;
  const draw = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const shown = shops.map((shop) => ({ ...shop, distanceKm: origin ? retailerDistanceKm(origin, shop) : null }))
      .filter((shop) => !query || `${shop.name} ${shop.address}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => origin ? (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
    if (!shown.length) { render(results, html`<p class="callout mb-0">${query ? "No approved retailer matches that search." : "There are no approved shops selling tickets in person yet. Check back soon."}</p>`); return; }
    render(results, html`${shown.map((shop) => {
      const destination = shop.latE6 == null || shop.lngE6 == null ? shop.address : `${shop.latE6 / 1e6},${shop.lngE6 / 1e6}`;
      const mapUrl = origin
        ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${origin.lat},${origin.lng}`)}&destination=${encodeURIComponent(destination)}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destination)}`;
      return html`<article class="card stack"><h3 class="mb-0">${shop.name}</h3><p class="small mb-0">${shop.address}</p>${origin ? html`<p class="tiny muted mb-0">${shop.distanceKm == null ? "Distance unavailable; shop location pin not set yet." : `${shop.distanceKm.toFixed(1)} km away`}</p>` : ""}<a class="btn btn-ghost btn-sm" href="${mapUrl}" target="_blank" rel="noopener noreferrer">${origin ? "Get directions" : "View on map"}</a></article>`;
    })}`);
  };
  try {
    const data = await get("/api/retail/locations");
    shops = data.retailers || [];
    status.textContent = shops.length ? `${shops.length} approved ${shops.length === 1 ? "shop" : "shops"} selling tickets in person.` : "No approved shops are listed yet.";
    draw();
  } catch {
    status.textContent = "We couldn’t load retailer locations right now. Please try again shortly.";
    locate.disabled = true; search.disabled = true;
    render(results, html`<div class="callout warn"><p class="mb-0">The retailer directory is temporarily unavailable.</p><button class="btn btn-ghost btn-sm mt" type="button" data-retail-retry>Try again</button></div>`);
    $("[data-retail-retry]", results).addEventListener("click", () => loadRetailDirectory());
    return;
  }
  locate.disabled = false; search.disabled = false;
  search.addEventListener("input", draw);
  locate.addEventListener("click", () => {
    if (!navigator.geolocation) { status.textContent = "Location is unavailable in this browser. Search by shop, suburb or town instead."; return; }
    locate.disabled = true; status.textContent = "Finding your location…";
    navigator.geolocation.getCurrentPosition((position) => {
      origin = { lat: position.coords.latitude, lng: position.coords.longitude };
      status.textContent = shops.some((shop) => shop.latE6 != null && shop.lngE6 != null)
        ? "Shops with saved map pins are sorted by distance. Your location stays in this page; directions open in Google Maps."
        : "No shop pins have been added yet, so the list stays alphabetical. Your location stays in this page; directions open in Google Maps.";
      locate.disabled = false; draw();
    }, (error) => {
      status.textContent = error.code === error.PERMISSION_DENIED ? "Location permission was declined. Search by shop, suburb or town to find a retailer." : "We couldn’t get your location. Search by shop, suburb or town instead.";
      locate.disabled = false;
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 });
  });
}
async function refreshState() {
  const box = $("#retail-state"); if (!box) return;
  let meData;
  // Signed out: ask the session first instead of letting the partner call fail.
  try { if (!(await me(true))) throw Object.assign(new Error("Signed out"), { status: 401 }); meData = await get("/api/retail/me"); }
  catch (err) {
    const localPreview = ["localhost", "127.0.0.1", "::1"].includes(location.hostname) && err.status === 404;
    if (localPreview) {
      render(box, html`<span class="cat-label">Local preview</span><h2>Retail applications need the TicketRoom API</h2><p class="muted">This preview serves the website files only, so it can’t check application status or save an application. On the deployed TicketRoom site, sign in here to apply or manage your retail account.</p>`);
      return;
    }
    if (err.status !== 401) {
      const maintenance = err.code === "maintenance";
      render(box, html`<span class="cat-label">Partner application</span><h2>${maintenance ? "Retail applications are paused for maintenance" : "We couldn’t load your retail application"}</h2><p class="muted">${maintenance ? "Retail applications will be available again when maintenance is over." : "We couldn’t check your application details just now. Nothing was changed. Please try again, or use the contact form if the problem continues."}</p><div class="row"><button class="btn btn-ghost" type="button" data-retail-retry>Try again</button><a class="btn btn-link" href="/contact">Contact us</a></div>`);
      $(`[data-retail-retry]`, box).addEventListener("click", refreshState);
      return;
    }
    render(box, html`<span class="cat-label">Partner application</span><h2>Apply to become a retail partner</h2><p class="muted">Sign in or create a TicketRoom account to apply. You’ll return here to complete your application, and approved partners manage their shop from this page.</p><button class="btn btn-primary" type="button" data-retail-signin>Sign in or create an account</button>`);
    $(`[data-retail-signin]`, box).addEventListener("click", () => authDialog("signin", { portal: "site", context: "retail", reason: "Sign in or create a TicketRoom account to continue your retail partner application.", onDone: refreshState }));
    return;
  }
  currentUser = meData.user;
  if (currentUser.accountType === "staff") return render(box, html`<span class="cat-label">TicketRoom staff account</span><h2>Retail applications use a separate account</h2><p class="muted">This account is for TicketRoom staff and can’t apply to sell tickets as a retail partner. Use a separate customer or organiser account to apply.</p><a class="btn btn-ghost" href="/admin">Open the Admin portal</a>`);
  const p = meData.application;
  if (p?.status === "approved") return partnerHome(p);
  if (p) return render(box, html`<span class="cat-label">Application ${p.ref}</span><h2>${p.business_name}</h2><p>Your application is <strong>${p.status.replace("_", " ")}</strong>. TicketRoom will email you when the review is complete.${p.review_note ? ` Note: ${p.review_note}` : ""}</p>`);
  render(box, html`<span class="cat-label">Apply</span><h2>Tell us about your shop</h2><p class="muted">TicketRoom reviews every partner before enabling sales. You’ll receive an application reference by email. Your email must be verified first.</p>
    ${!currentUser.emailVerified ? html`<p class="callout warn">Verify ${currentUser.email} in your account before applying.</p>` : ""}
    <form id="retail-apply" class="stack"><div class="grid-2"><div class="field"><label for="rp-name">Business or trading name</label><input id="rp-name" name="businessName" required minlength="2" maxlength="160" autocomplete="organization"></div>
      <div class="field"><label for="rp-reg">Company registration number <span class="muted">(optional)</span></label><input id="rp-reg" name="registrationNumber" maxlength="50"></div>
      <div class="field"><label for="rp-phone">Business contact number</label><input id="rp-phone" name="contactPhone" type="tel" required autocomplete="tel"></div>
      <div class="field"><label for="rp-address">Shop / business address</label><input id="rp-address" name="storeAddress" required minlength="5" maxlength="300" autocomplete="street-address"></div>
      <div class="field"><label for="rp-web">Website <span class="muted">(optional)</span></label><input id="rp-web" name="websiteUrl" type="url" placeholder="https://" maxlength="250"></div></div>
      <fieldset class="stack"><legend class="label">How do you plan to sell?</legend><label class="check"><input type="checkbox" name="physical"><span>In person at a shop or counter</span></label><label class="check"><input type="checkbox" name="online"><span>Online using partner links</span></label></fieldset>
      <p class="small muted mb-0">Application details are reviewed by TicketRoom. Don’t submit bank account details here.</p><button class="btn btn-primary" ${!currentUser.emailVerified ? "disabled" : ""}>Submit application</button></form>`);
  const f = $("#retail-apply");
  if (f) onSubmit(f, async (v) => {
    const salesChannels = [v.physical ? "physical" : null, v.online ? "online" : null].filter(Boolean);
    if (!salesChannels.length) { toast("Choose at least one way you plan to sell.", "bad"); return; }
    const result = await post("/api/retail/apply", { businessName: v.businessName, registrationNumber: v.registrationNumber || undefined, contactPhone: v.contactPhone, storeAddress: v.storeAddress, websiteUrl: v.websiteUrl || undefined, salesChannels });
    toast(`Application ${result.application.ref} sent for review.`, "good"); refreshState();
  });
}
async function partnerHome(partner) {
  const box = $("#retail-state");
  let data, sales = { orders: [], balanceCents: partner.balanceCents }, members = { members: [] };
  try { data = await get("/api/retail/events"); }
  catch (err) { render(box, html`<h2>Retail sales</h2><p>${err.message}</p>`); return; }
  try { sales = await get("/api/retail/sales"); } catch { /* event selling remains available if history is temporarily unavailable */ }
  if (partner.role === "owner") try { members = await get("/api/retail/members"); } catch { /* owner may retry from the next visit */ }
  render(box, html`<div class="row between"><div><span class="cat-label">Approved retail partner · ${partner.ref}</span><h2>${partner.business_name}</h2></div><div class="kpi"><div class="k">Earnings recorded</div><div class="v">${moneyExact(sales.balanceCents)}</div><div class="s">Unpaid partner share; finance records settlements</div></div></div>
    <div class="card flat stack"><h3>Your selling share</h3><p class="mb-0">Current rate: ${(data.rates.commissionShareBps / 100).toFixed(2)}% of net paid ticket value, split from the organiser commission, plus up to ${moneyExact(data.rates.serviceShareCents)} per paid ticket from the configured ${moneyExact(data.rates.serviceFeeCents)} service fee${data.rates.serviceFeeBps ? ` + ${(data.rates.serviceFeeBps / 100).toFixed(2)}%` : ""}. Admins control these rates. The share is capped by fees actually charged; free tickets earn no share. The rate in force when an order is created is recorded on that order.</p></div>
    ${data.partner.salesChannels.includes("physical") ? html`<h3 class="mt">Choose an event to sell at your counter</h3>${data.events.length ? html`<div class="stack">${data.events.map((e) => html`<article class="card row between"><div><strong>${e.title}</strong><div class="small muted">${fmtDate(e.starts_at)} · ${e.venue_name}, ${e.city} · ${plural(e.ticket_types_available, "ticket type")} available</div></div><button class="btn btn-primary" data-sell="${e.id}">Open sales</button></article>`)}</div>` : html`<p class="callout">No published events with tickets available right now. Check again soon.</p>`}` : ""}
    ${data.partner.salesChannels.includes("online") ? html`<h3 class="mt">Online partner links</h3><p class="small muted">Share a tracked event link; a completed ticket order through it appears in your partner earnings.</p><div class="stack">${data.events.slice(0,30).map((e) => { const url = `${location.origin}/events/${encodeURIComponent(e.slug)}?retailer=${encodeURIComponent(data.partner.ref)}`; return html`<div class="row between card flat"><span>${e.title}</span><div class="row"><a href="${url}" target="_blank" rel="noopener">Open link</a><button class="btn btn-ghost btn-sm" data-copy="${url}">Copy</button></div></div>`; })}</div>` : ""}
    <h3 class="mt">Recent sales</h3>${sales.orders.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Event</th><th>Order</th><th>Payment</th><th class="num">Total</th><th class="num">Share at sale</th></tr></thead><tbody>${sales.orders.map((o) => html`<tr><td>${fmtDate(o.created_at)}</td><td>${o.title}</td><td>${o.reference}${o.receipt_reference ? html`<div class="tiny muted">Receipt ${o.receipt_reference}</div>` : ""}</td><td>${o.tender_method || "Online"} · ${o.status.replace("_", " ")}</td><td class="num">${moneyExact(o.total_cents)}</td><td class="num">${moneyExact(Number(o.retail_commission_share_cents) + Number(o.retail_service_share_cents))}</td></tr>`)}</tbody></table></div>` : html`<p class="callout">Sales and partner earnings will appear here as soon as your first tickets are sold.</p>`}
    ${partner.role === "owner" && data.partner.salesChannels.includes("physical") ? html`<section class="card flat stack mt"><h3>Shop location</h3><p class="small muted mb-0">${data.partner.locationSet ? "A shop pin is saved and helps customers find you by distance." : "Add a map pin at your shop so nearby customers can see how far away you are."} Your browser will ask permission; only the shop coordinates are saved.</p><button class="btn btn-ghost" type="button" data-set-shop-location>${data.partner.locationSet ? "Update shop pin" : "Set shop pin"}</button></section>` : ""}
    ${partner.role === "owner" ? html`<section class="card flat stack mt"><h3>Shop team</h3><p class="small muted">Add sellers who already have a verified TicketRoom account. They can sell and cash up for this shop, but cannot manage the partner account.</p><form id="retail-member" class="row"><div class="field grow"><label for="retail-member-email">Seller’s TicketRoom email</label><input id="retail-member-email" name="email" type="email" required autocomplete="email"></div><button class="btn btn-ghost">Add seller</button></form><ul class="stack">${members.members.map((m) => html`<li class="row between"><span><strong>${m.full_name}</strong> <span class="badge plain">${String(m.role).charAt(0).toUpperCase() + String(m.role).slice(1)}</span><span class="small muted"> · ${m.email}</span></span>${m.role === "seller" ? html`<button class="btn btn-ghost btn-sm" data-remove-seller="${m.id}">Remove</button>` : ""}</li>`)}</ul></section>` : ""}
    <div class="card flat mt"><h3>Printer setup</h3><p class="mb-0">TicketRoom opens a print-ready ticket and has a separate compact receipt for cash or terminal sales. Use your browser’s print dialog for 58/80 mm receipt paper or standard A4 paper. TicketRoom does not send unsupported direct print commands to hardware.</p></div>`);
  box.querySelectorAll("[data-sell]").forEach((b) => b.addEventListener("click", () => {
    const eventId = b.dataset.sell;
    boxOfficeApp(box, eventId, { partnerMode: true, baseUrl: `/api/retail/events/${encodeURIComponent(eventId)}`, onBack: () => partnerHome(partner), backLabel: "All events" });
  }));
  box.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast("Partner link copied.", "good"); } catch { toast("Copy is unavailable in this browser. Open the link and copy it from the address bar.", "bad"); } }));
  box.querySelector("[data-set-shop-location]")?.addEventListener("click", (e) => {
    const button = e.currentTarget;
    if (!navigator.geolocation) { toast("Location is unavailable in this browser.", "bad"); return; }
    button.disabled = true;
    navigator.geolocation.getCurrentPosition(async (position) => {
      try {
        await post("/api/retail/location", { latE6: Math.round(position.coords.latitude * 1e6), lngE6: Math.round(position.coords.longitude * 1e6) });
        toast("Shop pin saved. Customers can now see your distance.", "good"); partnerHome(partner);
      } catch (err) { toast(err.message, "bad"); button.disabled = false; }
    }, (error) => { toast(error.code === error.PERMISSION_DENIED ? "Allow location access to save your shop pin." : "We couldn’t get your location. Try again at the shop.", "bad"); button.disabled = false; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
  const mf = $("#retail-member", box);
  if (mf) onSubmit(mf, async (v) => { await post("/api/retail/members", { email: v.email.trim() }); toast("Seller added. They can sign in to start selling.", "good"); partnerHome(partner); });
  box.querySelectorAll("[data-remove-seller]").forEach((b) => b.addEventListener("click", async () => { const m = members.members.find((x) => x.id === b.dataset.removeSeller); if (!m || !confirm(`Remove ${m.full_name} from this shop?`)) return; try { await del(`/api/retail/members/${encodeURIComponent(m.id)}`); toast("Seller access removed.", "good"); partnerHome(partner); } catch (err) { toast(err.message, "bad"); } }));
}

await header($("#header"), { authContext: "retail", onSignInDone: async () => {
  await header($("#header"));
  await refreshState();
} });
footer($("#footer"));
if (!emailLinkPage("site", "retail")) {
  try {
    const site = await get("/api/site");
    if (site.retail?.enabled) intro();
    else comingSoon(site.retail?.message);
  } catch {
    // Fail closed: without the live setting, never expose application or sales
    // controls. This also makes the static local preview show the default state.
    comingSoon();
  }
}
